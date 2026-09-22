/**
 * FirstMate DocModel — the document engine's shared format library.
 *
 * Isomorphic: loads as a browser global (window.FMDocModel) and as a
 * CommonJS module (imported by the v1 backend for validation, binding
 * resolution, and server-side rendering support).
 *
 * This file is the single source of truth for:
 *   - the DocModel JSON format (documents, pages, nodes, styles)
 *   - the expression/binding engine ({{params.x | money}})
 *   - override patches (instance edits stored against a template version)
 *   - theme token resolution
 *   - structural validation
 *
 * See docs/document-engine-spec.md and docs/document-engine-contracts.md.
 * Expressions are deliberately non-Turing-complete: paths, arithmetic,
 * comparisons, boolean logic, ternaries, whitelisted functions, and
 * formatter pipes. Real logic belongs in registered widgets.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FMDocModel = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  const SCHEMA_VERSION = 1;

  const NODE_TYPES = ["frame", "text", "image", "shape", "widget", "markup_overlay", "table", "component_ref", "repeater", "page_break"];
  const PAGE_ROLES = ["cover", "body", "pricing", "signature", "fine_print", "custom"];
  const DOCUMENT_KINDS = ["document", "view"];

  /**
   * Anchor semantics (word-processor model):
   *   "page"   — absolutely positioned in the page/parent space (default;
   *              all pre-v2 nodes behave this way).
   *   "flow"   — a block participating in a flow chain's layout.
   *   "inline" — lives inside a text run stream (checkbox, tag, small image).
   *   { to_block, offset, wrap } — floats with a paragraph; text wraps.
   */
  const ANCHOR_KINDS = ["page", "flow", "inline"];
  const HORIZONTAL_POSITION_UNITS = ["percent", "px"];
  const HORIZONTAL_POSITION_ANCHORS = ["left", "center", "right"];
  const RESPONSIVE_RESIZE_MODES = ["auto", "manual"];
  const RESPONSIVE_SIZE_UNITS = ["percent", "fixed"];
  const RESPONSIVE_HEIGHT_MODES = ["proportional", "fixed"];
  const PT_TO_PX = 96 / 72;

  // Physical page sizes in points (1pt = 1/72in).
  const PAPER_SIZES = {
    letter: { w_pt: 612, h_pt: 792 },
    legal: { w_pt: 612, h_pt: 1008 },
    a4: { w_pt: 595.28, h_pt: 841.89 }
  };

  const EDITOR_PROFILES = ["designer", "document", "fill", "inline"];

  const LOCKABLE = ["move", "resize", "rotate", "style", "content", "delete", "children"];

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  let idCounter = 0;
  function generateId(prefix) {
    idCounter = (idCounter + 1) % 1679616;
    const rand = Math.random().toString(36).slice(2, 8);
    const tick = Date.now().toString(36).slice(-5);
    return (prefix || "n") + "_" + tick + rand + idCounter.toString(36);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function deepClone(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(deepClone);
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }

  function deepMerge(base, patch) {
    if (!isObject(base) || !isObject(patch)) return deepClone(patch === undefined ? base : patch);
    const out = deepClone(base);
    for (const key of Object.keys(patch)) {
      const next = patch[key];
      out[key] = isObject(out[key]) && isObject(next) ? deepMerge(out[key], next) : deepClone(next);
    }
    return out;
  }

  const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  function splitPath(path) {
    if (Array.isArray(path)) return path.slice();
    return String(path)
      .split(".")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      .filter((part) => part !== "");
  }

  function getPath(target, path) {
    let current = target;
    for (const key of splitPath(path)) {
      if (current === null || current === undefined) return undefined;
      if (typeof key === "string" && UNSAFE_KEYS.has(key)) return undefined;
      current = current[key];
    }
    return current;
  }

  function setPath(target, path, value) {
    const parts = splitPath(path);
    if (!parts.length) return target;
    let current = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (typeof key === "string" && UNSAFE_KEYS.has(key)) return target;
      if (current[key] === null || current[key] === undefined || typeof current[key] !== "object") {
        current[key] = typeof parts[i + 1] === "number" ? [] : {};
      }
      current = current[key];
    }
    const last = parts[parts.length - 1];
    if (typeof last === "string" && UNSAFE_KEYS.has(last)) return target;
    current[last] = value;
    return target;
  }

  function round2(value) {
    const rounded = Math.round(value * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  /** Canonical responsive horizontal placement. `value` is a signed offset
   * from the matching parent anchor; the same edge/centre of the item is
   * mounted there. Percent offsets use parent width, while px offsets are
   * stable CSS pixels. */
  function normalizeHorizontalPosition(value) {
    const source = isObject(value) ? value : {};
    const numeric = Number(source.value);
    return {
      unit: HORIZONTAL_POSITION_UNITS.includes(source.unit) ? source.unit : "percent",
      anchor: HORIZONTAL_POSITION_ANCHORS.includes(source.anchor) ? source.anchor : "center",
      value: round2(Number.isFinite(numeric) ? numeric : 0)
    };
  }

  function horizontalPositionToLeft(position, parentWidthPx, itemWidthPx) {
    const pos = normalizeHorizontalPosition(position);
    const parentWidth = Math.max(0, Number(parentWidthPx) || 0);
    const itemWidth = Math.max(0, Number(itemWidthPx) || 0);
    const offset = pos.unit === "percent" ? parentWidth * pos.value / 100 : pos.value;
    if (pos.anchor === "left") return offset;
    if (pos.anchor === "right") return parentWidth + offset - itemWidth;
    return parentWidth / 2 + offset - itemWidth / 2;
  }

  function horizontalPositionFromLeft(leftPx, itemWidthPx, parentWidthPx, options) {
    const basis = normalizeHorizontalPosition(options);
    const parentWidth = Math.max(0, Number(parentWidthPx) || 0);
    const itemWidth = Math.max(0, Number(itemWidthPx) || 0);
    const left = Number(leftPx) || 0;
    let offset = left;
    if (basis.anchor === "center") offset = left + itemWidth / 2 - parentWidth / 2;
    else if (basis.anchor === "right") offset = left + itemWidth - parentWidth;
    const value = basis.unit === "percent" && parentWidth > 0 ? offset / parentWidth * 100 : offset;
    return { unit: basis.unit, anchor: basis.anchor, value: round2(value) };
  }

  /** Web-only element resize behavior. Auto is intentionally the canonical
   * default: both horizontal edges and the vertical size derive from the
   * parent width. Manual exposes independent placement, width and height
   * choices without changing document-page geometry. */
  function normalizeResponsiveResize(value) {
    const source = isObject(value) ? value : {};
    return {
      mode: RESPONSIVE_RESIZE_MODES.includes(source.mode) ? source.mode : "auto",
      width: RESPONSIVE_SIZE_UNITS.includes(source.width) ? source.width : "fixed",
      height: RESPONSIVE_HEIGHT_MODES.includes(source.height) ? source.height : "fixed"
    };
  }

  /** Group authored absolute children into vertical rows. Items whose
   * vertical intervals overlap belong to the same row; a following row owns
   * only the gap after the previous row's maximum bottom. This prevents two
   * side-by-side items from pushing downstream content twice. */
  function responsiveAutoRows(children) {
    const entries = (Array.isArray(children) ? children : [])
      .filter((node) => {
        const frame = node && node.frame;
        return frame && typeof frame.y === "number" && typeof frame.h === "number" && frame.h >= 0
          && normalizeResponsiveResize(frame.responsive).mode === "auto";
      })
      .map((node) => ({ node, top: Number(node.frame.y) || 0, bottom: (Number(node.frame.y) || 0) + (Number(node.frame.h) || 0) }))
      .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
    const rows = [];
    for (const entry of entries) {
      let row = rows[rows.length - 1];
      if (!row || entry.top >= row.bottom) {
        const previousBottom = row ? row.bottom : 0;
        row = { index: rows.length, top: entry.top, bottom: entry.bottom, gap_above: Math.max(0, entry.top - previousBottom), items: [] };
        rows.push(row);
      } else {
        row.top = Math.min(row.top, entry.top);
        row.bottom = Math.max(row.bottom, entry.bottom);
      }
      row.items.push({ id: entry.node.id, offset_top: round2(entry.top - row.top), height: round2(entry.bottom - entry.top) });
    }
    return rows;
  }

  function isMobileViewSection(section) {
    return !!(section && section.type === "frame" && section.props && section.props.view_variant === "mobile" && section.props.variant_of);
  }

  function desktopViewSection(doc, sectionOrId) {
    if (!doc || doc.kind !== "view" || !doc.root) return null;
    const id = typeof sectionOrId === "string" ? sectionOrId : sectionOrId && sectionOrId.id;
    const section = (doc.root.children || []).find((item) => item && item.id === id) || (typeof sectionOrId === "object" ? sectionOrId : null);
    if (!section) return null;
    if (!isMobileViewSection(section)) return section;
    return (doc.root.children || []).find((item) => item && item.id === section.props.variant_of) || null;
  }

  function mobileViewSection(doc, desktopOrId) {
    const desktop = desktopViewSection(doc, desktopOrId);
    if (!desktop || !doc || !doc.root) return null;
    return (doc.root.children || []).find((item) => isMobileViewSection(item) && item.props.variant_of === desktop.id) || null;
  }

  /** Logical website sections for an editing/rendering viewport. Mobile uses
   * the paired clone only when the desktop section explicitly enables it;
   * otherwise it falls back to the exact desktop section. */
  function activeViewSections(doc, variant) {
    if (!doc || doc.kind !== "view" || !doc.root) return [];
    const children = Array.isArray(doc.root.children) ? doc.root.children : [];
    const desktops = children.filter((section) => section && section.type === "frame" && !isMobileViewSection(section));
    if (variant !== "mobile") return desktops;
    return desktops.map((desktop) => {
      if (!(desktop.props && desktop.props.mobile_variant_enabled === true)) return desktop;
      const mobile = mobileViewSection(doc, desktop);
      return mobile && mobile.props && mobile.props.mobile_enabled === true ? mobile : desktop;
    });
  }

  function normalizeMobileText(node) {
    if (!node) return;
    if (node.type === "text") {
      node.style = isObject(node.style) ? node.style : {};
      node.style.font = isObject(node.style.font) ? node.style.font : {};
      const current = Number(node.style.font.size_pt) || 12;
      const blocks = node.props && Array.isArray(node.props.blocks) ? node.props.blocks : [];
      const heading = blocks.some((block) => block && block.type === "heading") || current >= 18;
      node.style.font.size_pt = round2(heading ? Math.max(20, Math.min(32, current)) : Math.max(13, Math.min(18, current)));
      // A heading's glyph box is commonly taller than its authored desktop
      // frame once the font is normalized for phone readability. Reserve a
      // full line box plus breathing room so the following row can never
      // visually collide with it.
      if (typeof node.frame?.h === "number") node.frame.h = Math.max(node.frame.h, node.style.font.size_pt * (heading ? 2.05 : 1.9));
    }
    for (const child of Array.isArray(node.children) ? node.children : []) normalizeMobileText(child);
  }

  /** Deterministic first-pass mobile layout. Horizontally aligned siblings
   * are detected by overlapping vertical intervals, ordered left-to-right,
   * and stacked into one centered column with stable gutters. */
  function mobilizeViewSection(section, options) {
    if (!section || section.type !== "frame") return section;
    const parentWidth = Math.max(1, Number(section.frame && section.frame.w) || Number(options && options.parent_width_pt) || 720);
    const children = (Array.isArray(section.children) ? section.children : []).filter((node) => node && node.frame && typeof node.frame.y === "number");
    const entries = children.map((node) => ({ node, top: Number(node.frame.y) || 0, bottom: (Number(node.frame.y) || 0) + Math.max(0, Number(node.frame.h) || 0) }))
      .sort((a, b) => a.top - b.top || (Number(a.node.frame.x) || 0) - (Number(b.node.frame.x) || 0));
    const rows = [];
    for (const entry of entries) {
      let row = rows[rows.length - 1];
      if (!row || entry.top >= row.bottom) {
        row = { top: entry.top, bottom: entry.bottom, items: [] };
        rows.push(row);
      } else row.bottom = Math.max(row.bottom, entry.bottom);
      row.items.push(entry.node);
    }
    const paintedDesktopLeft = (node) => {
      const frame = node && node.frame || {};
      const responsive = normalizeResponsiveResize(frame.responsive);
      // Manual placement renders from the canonical mount, not frame.x. Magic
      // previously sampled frame.x anyway, which explains a desktop-symmetric
      // row becoming asymmetric as soon as its mobile clone was generated.
      if (responsive.mode === "manual" && frame.position && frame.position.x) {
        return horizontalPositionToLeft(frame.position.x, parentWidth, Math.max(1, Number(frame.w) || 1));
      }
      return Number(frame.x) || 0;
    };
    const rowEnvelope = (row) => {
      const left = Math.min.apply(null, row.items.map((node) => paintedDesktopLeft(node)));
      const right = Math.max.apply(null, row.items.map((node) => paintedDesktopLeft(node) + Math.max(1, Number(node.frame.w) || 1)));
      return { left: Math.max(0, left), right: Math.min(parentWidth, right), width: Math.max(1, Math.min(parentWidth, right) - Math.max(0, left)) };
    };
    // The strongest layout signal is the outer envelope of a desktop row that
    // actually needs stacking. Its first left edge and last right edge become
    // percentage rails for every generated mobile block. This naturally keeps
    // headings, paragraphs, and stacked media aligned without inventing a new
    // mobile margin.
    const railRows = rows.filter((row) => row.items.length > 1);
    const railSource = (railRows.length ? railRows : rows).map((row) => ({ row, envelope: rowEnvelope(row) }))
      .sort((a, b) => b.envelope.width - a.envelope.width)[0];
    const authoredRail = railSource ? railSource.envelope : { left: parentWidth * 0.07, right: parentWidth * 0.93, width: parentWidth * 0.86 };
    // Mobile's generated column is centered by contract. Preserve the desktop
    // row's *width*, but do not carry a stale/asymmetric desktop x coordinate
    // into the phone projection. The latter can differ from painted desktop
    // geometry after responsive mounting and was producing unequal gutters.
    const railInset = Math.max(0, (parentWidth - authoredRail.width) / 2);
    const rail = { left: railInset, right: parentWidth - railInset, width: authoredRail.width };
    const contentWidth = rail.width;
    // These coordinates are authored against the desktop design width and
    // then projected into a ~phone-width container. A small fixed-point gap
    // becomes visually tiny, so use a width-relative rhythm that resolves to
    // roughly 24–32px on common phones.
    const gutter = Math.max(36, Math.min(58, parentWidth * 0.065));
    let cursor = Math.max(24, Math.min(52, entries.length ? entries[0].top : 32));
    let previousRow = null;
    for (const row of rows) {
      if (previousRow) {
        const authoredGap = Math.max(0, row.top - previousRow.bottom);
        const followsText = previousRow.items.some((node) => node && node.type === "text");
        const beginsVisuals = row.items.some((node) => node && (node.type === "image" || node.type === "shape" || node.type === "widget" || node.type === "frame"));
        const semanticFloor = gutter * (followsText && beginsVisuals ? 1.2 : 1);
        // Preserve an intentionally generous desktop gap, but cap it so a
        // sparse desktop canvas cannot turn into an enormous empty phone area.
        cursor += Math.max(semanticFloor, Math.min(gutter * 1.75, authoredGap));
      }
      row.items.sort((a, b) => (Number(a.frame.x) || 0) - (Number(b.frame.x) || 0));
      for (let itemIndex = 0; itemIndex < row.items.length; itemIndex += 1) {
        const node = row.items[itemIndex];
        const frame = node.frame;
        const oldWidth = Math.max(1, Number(frame.w) || contentWidth);
        const ownLeft = Math.max(0, paintedDesktopLeft(node));
        const ownRight = Math.min(parentWidth, ownLeft + oldWidth);
        const alignsWithRow = Math.abs(ownLeft - rail.left) <= parentWidth * 0.025
          && Math.abs(ownRight - rail.right) <= parentWidth * 0.025;
        // Standalone titles/paragraphs keep their authored desktop rails. Text
        // that was deliberately aligned to the gallery row continues to share
        // the gallery rails, but Magic never arbitrarily narrows a title.
        const ownWidth = Math.max(1, ownRight - ownLeft);
        const ownInset = Math.max(0, (parentWidth - ownWidth) / 2);
        const nodeRail = node.type === "text" && !alignsWithRow
          // A standalone title keeps its authored width, while its mobile
          // projection is centered rather than inheriting an x-offset.
          ? { left: ownInset, right: parentWidth - ownInset, width: ownWidth }
          : rail;
        const targetWidth = nodeRail.width;
        const scale = targetWidth / oldWidth;
        frame.w = round2(targetWidth);
        if (typeof frame.h === "number" && node.type !== "text") frame.h = round2(Math.max(12, frame.h * scale));
        normalizeMobileText(node);
        frame.x = round2(nodeRail.left);
        frame.y = round2(cursor);
        frame.responsive = normalizeResponsiveResize({ mode: "auto" });
        node.props = isObject(node.props) ? node.props : {};
        delete node.props.magic_mobile_centered;
        node.props.magic_mobile_rails = {
          left_percent: round2(nodeRail.left / parentWidth * 100),
          right_percent: round2(Math.max(0, parentWidth - nodeRail.right) / parentWidth * 100)
        };
        cursor += Math.max(1, Number(frame.h) || 24);
        if (itemIndex < row.items.length - 1) {
          const largeVisual = node.type === "image" || node.type === "shape" || node.type === "frame";
          cursor += gutter * (largeVisual ? 1.1 : 1);
        }
      }
      previousRow = row;
    }
    section.frame = isObject(section.frame) ? section.frame : {};
    section.frame.h = round2(Math.max(72, cursor + gutter));
    return section;
  }

  function createMobileViewSection(section, options) {
    if (!section || section.type !== "frame") return null;
    const sourceId = section.props && section.props.view_variant === "mobile" ? section.props.variant_of : section.id;
    const clone = reassignIds(section);
    clone.name = String(section.name || "Section") + " · Mobile";
    clone.props = isObject(clone.props) ? clone.props : {};
    delete clone.props.mobile_variant_enabled;
    clone.props.view_variant = "mobile";
    clone.props.variant_of = sourceId;
    clone.props.mobile_enabled = true;
    linkMobileVariantSources(section, clone);
    if (options && options.magic === true) mobilizeViewSection(clone, options);
    return clone;
  }

  /** Reconnect an independently cloned phone tree to its paired desktop tree.
   * Tree shape/order is stable for a duplicate, while ids are intentionally
   * independent so edits cannot leak across variants. */
  function linkMobileVariantSources(source, mobile) {
    (function linkSources(sourceNode, mobileNode) {
      if (!sourceNode || !mobileNode) return;
      mobileNode.props = isObject(mobileNode.props) ? mobileNode.props : {};
      mobileNode.props.variant_source_id = sourceNode.id;
      const sourceChildren = Array.isArray(sourceNode.children) ? sourceNode.children : [];
      const mobileChildren = Array.isArray(mobileNode.children) ? mobileNode.children : [];
      for (let i = 0; i < Math.min(sourceChildren.length, mobileChildren.length); i += 1) linkSources(sourceChildren[i], mobileChildren[i]);
    })(source, mobile);
    return mobile;
  }

  /** Give every absolutely positioned descendant of a view section an
   * explicit responsive contract. Existing visual coordinates are preserved
   * at the design width while the canonical default remains centre-mounted
   * percentage placement. Mutates and returns `doc`, matching resolveBindings
   * and the other model normalization passes. */
  function normalizeViewHorizontalPositions(doc, options) {
    if (!doc || doc.kind !== "view" || !doc.root) return doc;
    const configuredWidth = Number(options && options.parent_width_pt);
    const defaultResponsiveMode = options && options.default_responsive_mode === "manual" ? "manual" : "auto";
    const rootWidthPt = Number.isFinite(configuredWidth) && configuredWidth > 0
      ? configuredWidth
      : (typeof doc.root.frame?.w === "number" && doc.root.frame.w > 0 ? doc.root.frame.w : paperDimensions(doc).w_pt || 720);
    function visit(parent, parentWidthPt, structural) {
      for (const child of Array.isArray(parent.children) ? parent.children : []) {
        const frame = isObject(child.frame) ? child.frame : null;
        const isStructural = parent === doc.root;
        // frame.layout controls the CHILDREN of this node. Whether this node
        // participates in flow is owned by its parent plus its anchor.
        const parentFlows = parent && parent.frame && parent.frame.layout === "flow";
        const inFlow = !frame || child.anchor === "inline" || (parentFlows && child.anchor !== "page");
        if (structural && frame && !inFlow) {
          frame.responsive = normalizeResponsiveResize(isObject(frame.responsive) ? frame.responsive : { mode: defaultResponsiveMode });
          frame.position = isObject(frame.position) ? frame.position : {};
          if (!isObject(frame.position.x)) {
            const widthPt = typeof frame.w === "number" ? frame.w : 0;
            frame.position.x = horizontalPositionFromLeft(
              (Number(frame.x) || 0) * PT_TO_PX,
              widthPt * PT_TO_PX,
              parentWidthPt * PT_TO_PX,
              { unit: "percent", anchor: "center", value: 0 }
            );
          } else {
            frame.position.x = normalizeHorizontalPosition(frame.position.x);
          }
        }
        const childWidthPt = frame && typeof frame.w === "number" && frame.w > 0 ? frame.w : parentWidthPt;
        visit(child, childWidthPt, structural || isStructural);
      }
    }
    visit(doc.root, rootWidthPt, false);
    return doc;
  }

  // ---------------------------------------------------------------------------
  // Factories
  // ---------------------------------------------------------------------------

  const DEFAULT_FRAME = {
    x: 0,
    y: 0,
    w: 120,
    h: 40,
    rotation: 0,
    z: 0,
    layout: "absolute",
    constraints: { h: "left", v: "top" }
  };

  const NODE_DEFAULTS = {
    frame: () => ({
      props: {
        background: null,
        clip: false,
        flow: { direction: "column", gap: 8, padding: [0, 0, 0, 0], align: "stretch", wrap: false },
        overflow: "visible"
      }
    }),
    text: () => ({
      props: {
        blocks: [
          {
            id: generateId("blk"),
            type: "paragraph",
            align: "left",
            runs: [{ text: "" }]
          }
        ],
        valign: "top",
        auto_fit: false,
        line_height: 1.4,
        letter_spacing: 0
      }
    }),
    image: () => ({
      props: {
        media: null, // { media_id, variant, markup_layer_id? } or { url } for external/dev
        fit: "cover",
        focal: { x: 0.5, y: 0.5 },
        crop: null,
        alt: ""
      }
    }),
    shape: () => ({
      props: {
        shape: "rect", // rect | ellipse | line | polygon | path
        points: null, // polygon/line: [{x,y}...] normalized 0..1 within frame
        d: null, // path: SVG path data in a 0..1 unit space
        corner_radius: 0
      }
    }),
    widget: () => ({
      props: {
        widget: null, // "doc.line_items@1"
        config: {}
      }
    }),
    markup_overlay: () => ({
      props: {
        media_id: null,
        layer_id: null,
        revision: null
      }
    }),
    table: () => ({
      props: {
        columns: [], // [{id, width_pt|width_frac, align}]
        rows: [], // [{id, cells:[{blocks:[...] }]}]
        header: true,
        row_stripe: false
      }
    }),
    component_ref: () => ({
      props: {
        component: null, // component def name (doc.components / template / org library)
        variant: null,
        input: {}, // { paramName: value | "{{expr}}" }
        detached: false // true = instance was forked; children carry the fork
      }
    }),
    repeater: () => ({
      props: {
        source: null, // list expression: "{{params.scope_items}}" or named source sugar
        component: null,
        variant: null,
        as: "row",
        index_as: "index",
        layout: { direction: "column", columns: 1, gap_pt: 6 },
        break_rules: { repeat_header: false, min_rows_per_segment: 1, keep_with_next: [] },
        empty_text: ""
      }
    }),
    page_break: () => ({
      props: {} // flow-anchored explicit page/column break
    })
  };

  function createNode(type, overrides) {
    if (!NODE_TYPES.includes(type)) throw new Error("Unknown DocModel node type: " + type);
    const defaults = NODE_DEFAULTS[type]();
    const node = {
      id: generateId("nd"),
      type,
      name: "",
      frame: deepClone(DEFAULT_FRAME),
      style: {},
      locks: {},
      bind: null,
      visible: true,
      props: defaults.props,
      children: type === "frame" ? [] : undefined
    };
    if (type !== "frame") delete node.children;
    return overrides ? deepMerge(node, overrides) : node;
  }

  function createPage(role, overrides) {
    const page = {
      id: generateId("pg"),
      role: PAGE_ROLES.includes(role) ? role : "body",
      name: "",
      master_ref: null,
      repeat: null,
      children: []
    };
    return overrides ? deepMerge(page, overrides) : page;
  }

  function createDocument(options) {
    const opts = options || {};
    const kind = DOCUMENT_KINDS.includes(opts.kind) ? opts.kind : "document";
    const doc = {
      schema_version: SCHEMA_VERSION,
      kind,
      settings: {
        paper: { size: opts.paper || "letter", orientation: opts.orientation || "portrait" },
        locale: opts.locale || "en-US",
        base_font_pt: opts.base_font_pt || 11
      },
      theme_ref: opts.theme_ref || null,
      params: opts.params || {},
      computed: opts.computed || {},
      outputs: opts.outputs || {},
      // v2 additions (all optional; absent on older documents):
      styles: opts.styles || {}, // named block styles: { body: {font...,spacing...}, h1: {...} } — resolved doc → template → theme.type_styles
      components: opts.components || {}, // { name: { params:{}, root:Node, variants:{...} } }
      chains: opts.chains || {}, // { body: { auto_pages, page_defaults:{role,margins_pt,columns,column_gap_pt}, keep_rules } }
      assets: [],
      edit_policy: opts.edit_policy || { base_profile: "document", max_profile: "designer", features: {}, unlock: { allowed: true } },
      metadata: opts.metadata || {}
    };
    if (kind === "view") {
      doc.root = createNode("frame", { name: "Root", frame: { layout: "flow", x: 0, y: 0, w: 800, h: 0 } });
    } else {
      doc.pages = [createPage(opts.first_page_role || "body")];
    }
    return doc;
  }

  /**
   * A ready-to-type Letter document. This is intentionally separate from
   * createDocument(): template builders use the low-level factory when they
   * need a genuinely empty canvas, while "Blank" in the product should feel
   * like opening a new word-processing document.
   */
  function createBlankDocument(options) {
    const opts = options || {};
    const margins = { top: 72, right: 72, bottom: 72, left: 72, ...(opts.margins_pt || {}) };
    const doc = createDocument({
      ...opts,
      kind: "document",
      paper: opts.paper || "letter",
      first_page_role: opts.first_page_role || "body",
      styles: opts.styles || {
        "Normal text": { font: { size_pt: 11, weight: 400 }, line_height: 1.4 },
        Title: { font: { size_pt: 26, weight: 400 }, line_height: 1.2, space_after_pt: 10 },
        Subtitle: { font: { size_pt: 15, weight: 400, color: "#5f6368" }, line_height: 1.3, space_after_pt: 8 },
        "Heading 1": { font: { size_pt: 20, weight: 600 }, line_height: 1.25, space_before_pt: 12, space_after_pt: 6 },
        "Heading 2": { font: { size_pt: 16, weight: 600 }, line_height: 1.3, space_before_pt: 10, space_after_pt: 5 },
        "Heading 3": { font: { size_pt: 14, weight: 600 }, line_height: 1.35, space_before_pt: 8, space_after_pt: 4 }
      }
    });
    doc.chains = {
      header: { auto_pages: false, page_defaults: { role: "body", margins_pt: margins, columns: 1, column_gap_pt: 24 }, keep_rules: {} },
      body: { auto_pages: true, page_defaults: { role: "body", margins_pt: margins, columns: 1, column_gap_pt: 24 }, keep_rules: { widow_lines: 2, orphan_lines: 2 } },
      footer: { auto_pages: false, page_defaults: { role: "body", margins_pt: margins, columns: 1, column_gap_pt: 24 }, keep_rules: {} }
    };
    const text = function (name) {
      return createNode("text", {
        name,
        anchor: "flow",
        frame: { x: 0, y: 0, w: 0, h: "auto", z: 0, layout: "flow" },
        props: { blocks: [{ id: generateId("blk"), type: "paragraph", style_ref: "Normal text", runs: [{ text: "" }] }], valign: "top", auto_fit: false, line_height: 1.4, letter_spacing: 0 }
      });
    };
    const frame = function (name, chainId, pageRegion, box) {
      return createNode("frame", {
        name,
        frame: { ...box, rotation: 0, z: 0, layout: "flow", constraints: { h: "stretch", v: "top" } },
        props: { chain: { id: chainId, index: 0 }, page_region: pageRegion, flow: { direction: "column", gap: 0, padding: [0, 0, 0, 0], align: "stretch", wrap: false }, overflow: "hidden" },
        children: [text(name + " text")]
      });
    };
    doc.pages[0].name = "Page 1";
    doc.pages[0].children = [
      frame("Header", "header", "header", { x: margins.left, y: 24, w: 612 - margins.left - margins.right, h: 30 }),
      frame("Body", "body", "body", { x: margins.left, y: margins.top, w: 612 - margins.left - margins.right, h: 792 - margins.top - margins.bottom }),
      frame("Footer", "footer", "footer", { x: margins.left, y: 738, w: 612 - margins.left - margins.right, h: 30 })
    ];
    doc.metadata = { ...doc.metadata, blank_word_document: true };
    return doc;
  }

  function paperDimensions(doc) {
    const paper = (doc && doc.settings && doc.settings.paper) || {};
    let dims = PAPER_SIZES.letter;
    // "fill": fluid view surface (websites) — width follows the container.
    // The nominal w_pt only anchors zoom/thumbnail math; renderers treat the
    // fill flag as "width: 100%".
    if (paper.size === "fill") return { w_pt: 720, h_pt: PAPER_SIZES.letter.h_pt, fill: true };
    if (typeof paper.size === "string" && PAPER_SIZES[paper.size]) dims = PAPER_SIZES[paper.size];
    // Width-only object sizes are valid for view docs (h grows with content).
    else if (isObject(paper.size) && paper.size.w_pt) dims = { w_pt: paper.size.w_pt, h_pt: paper.size.h_pt || 0 };
    if (paper.orientation === "landscape") return { w_pt: dims.h_pt, h_pt: dims.w_pt };
    return { w_pt: dims.w_pt, h_pt: dims.h_pt };
  }

  // ---------------------------------------------------------------------------
  // Tree operations
  // ---------------------------------------------------------------------------

  function documentRoots(doc) {
    if (!doc) return [];
    if (doc.kind === "view") return doc.root ? [doc.root] : [];
    return Array.isArray(doc.pages) ? doc.pages : [];
  }

  /**
   * Visit every node. fn(node, context) where context =
   * { parent, page, index, depth, path }. Return false from fn to skip children.
   */
  function walkNodes(doc, fn) {
    const visit = (node, parent, page, index, depth, path) => {
      const result = fn(node, { parent, page, index, depth, path });
      if (result === false) return;
      const children = node.children;
      if (Array.isArray(children)) {
        for (let i = 0; i < children.length; i += 1) {
          visit(children[i], node, page, i, depth + 1, path.concat(["children", i]));
        }
      }
    };
    if (doc.kind === "view") {
      if (doc.root) visit(doc.root, null, null, 0, 0, ["root"]);
      return;
    }
    const pages = doc.pages || [];
    for (let p = 0; p < pages.length; p += 1) {
      const page = pages[p];
      const children = page.children || [];
      for (let i = 0; i < children.length; i += 1) {
        visit(children[i], null, page, i, 1, ["pages", p, "children", i]);
      }
    }
  }

  function findNode(doc, nodeId) {
    let found = null;
    walkNodes(doc, (node, ctx) => {
      if (node.id === nodeId) {
        found = { node, parent: ctx.parent, page: ctx.page, index: ctx.index, path: ctx.path };
        return false;
      }
      return undefined;
    });
    return found;
  }

  function findPage(doc, pageId) {
    const pages = doc.pages || [];
    for (let i = 0; i < pages.length; i += 1) {
      if (pages[i].id === pageId) return { page: pages[i], index: i };
    }
    return null;
  }

  function nodeContainer(doc, parentId, pageId) {
    if (parentId) {
      const parent = findNode(doc, parentId);
      if (!parent || parent.node.type !== "frame") return null;
      if (!Array.isArray(parent.node.children)) parent.node.children = [];
      return parent.node.children;
    }
    if (doc.kind === "view") {
      if (!doc.root) return null;
      if (!Array.isArray(doc.root.children)) doc.root.children = [];
      return doc.root.children;
    }
    const page = pageId ? findPage(doc, pageId) : null;
    if (!page) return null;
    if (!Array.isArray(page.page.children)) page.page.children = [];
    return page.page.children;
  }

  function insertNode(doc, node, target) {
    const t = target || {};
    const container = nodeContainer(doc, t.parent_id || null, t.page_id || null);
    if (!container) return false;
    const index = typeof t.index === "number" ? Math.max(0, Math.min(t.index, container.length)) : container.length;
    container.splice(index, 0, node);
    return true;
  }

  function removeNode(doc, nodeId) {
    let removed = null;
    const removeFrom = (list) => {
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].id === nodeId) {
          removed = list.splice(i, 1)[0];
          return true;
        }
        if (Array.isArray(list[i].children) && removeFrom(list[i].children)) return true;
      }
      return false;
    };
    if (doc.kind === "view") {
      if (doc.root && Array.isArray(doc.root.children)) removeFrom(doc.root.children);
    } else {
      for (const page of doc.pages || []) {
        if (Array.isArray(page.children) && removeFrom(page.children)) break;
      }
    }
    return removed;
  }

  function collectIds(doc) {
    const ids = [];
    if (Array.isArray(doc.pages)) for (const page of doc.pages) ids.push(page.id);
    walkNodes(doc, (node) => {
      ids.push(node.id);
    });
    return ids;
  }

  /** Reassign every node id in a fragment (used by paste/duplicate). */
  function reassignIds(fragment) {
    const clone = deepClone(fragment);
    const visit = (node) => {
      node.id = generateId("nd");
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    if (Array.isArray(clone)) clone.forEach(visit);
    else visit(clone);
    return clone;
  }

  // ---------------------------------------------------------------------------
  // Override patches
  //
  // Instance edits are stored as an ordered op list against the template
  // version, so templates stay authoritative and instances survive template
  // updates. Ops address nodes by id, never by array index.
  // ---------------------------------------------------------------------------

  const OVERRIDE_OPS = ["doc.set", "node.set", "node.insert", "node.remove", "node.move", "page.insert", "page.remove", "page.move", "page.set"];

  function applyOverride(doc, op) {
    switch (op.op) {
      case "doc.set":
        setPath(doc, op.prop, deepClone(op.value));
        return true;
      case "node.set": {
        const found = findNode(doc, op.node_id);
        if (!found) return false;
        setPath(found.node, op.prop, deepClone(op.value));
        return true;
      }
      case "node.insert":
        return insertNode(doc, deepClone(op.node), { parent_id: op.parent_id, page_id: op.page_id, index: op.index });
      case "node.remove":
        return removeNode(doc, op.node_id) !== null;
      case "node.move": {
        const removed = removeNode(doc, op.node_id);
        if (!removed) return false;
        if (op.frame) removed.frame = deepMerge(removed.frame, op.frame);
        return insertNode(doc, removed, { parent_id: op.parent_id, page_id: op.page_id, index: op.index });
      }
      case "page.insert": {
        if (doc.kind !== "document") return false;
        const index = typeof op.index === "number" ? Math.max(0, Math.min(op.index, doc.pages.length)) : doc.pages.length;
        doc.pages.splice(index, 0, deepClone(op.page));
        return true;
      }
      case "page.remove": {
        const found = findPage(doc, op.page_id);
        if (!found) return false;
        doc.pages.splice(found.index, 1);
        return true;
      }
      case "page.move": {
        const found = findPage(doc, op.page_id);
        if (!found) return false;
        const [page] = doc.pages.splice(found.index, 1);
        const index = Math.max(0, Math.min(op.index, doc.pages.length));
        doc.pages.splice(index, 0, page);
        return true;
      }
      case "page.set": {
        const found = findPage(doc, op.page_id);
        if (!found) return false;
        setPath(found.page, op.prop, deepClone(op.value));
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Apply instance overrides to a template definition. Returns
   * { document, applied, skipped } — skipped ops (e.g. the template removed a
   * node an override touched) are reported, never fatal.
   */
  function applyOverrides(definition, ops) {
    const doc = deepClone(definition);
    const skipped = [];
    let applied = 0;
    for (const op of ops || []) {
      if (applyOverride(doc, op)) applied += 1;
      else skipped.push(op);
    }
    return { document: doc, applied, skipped };
  }

  // ---------------------------------------------------------------------------
  // Expression engine
  //
  // Grammar (non-Turing-complete):
  //   pipe       := ternary ("|" formatter)*
  //   ternary    := or ("?" pipe ":" pipe)?
  //   or         := and ("||" and)*
  //   and        := equality ("&&" equality)*
  //   equality   := relational (("=="|"!=") relational)*
  //   relational := additive (("<"|">"|"<="|">=") additive)*
  //   additive   := multiplicative (("+"|"-") multiplicative)*
  //   multiplicative := unary (("*"|"/"|"%") unary)*
  //   unary      := ("!"|"-") unary | postfix
  //   postfix    := primary ("." ident | "[" expr "]" | "[]" | "(" args ")")*
  //   primary    := number | string | true | false | null | ident | "(" pipe ")"
  //
  // Paths resolve against the scope; "[]" maps the remaining path over an
  // array (params.items[].amount_cents -> number[]). Function calls are only
  // allowed on whitelisted bare identifiers.
  // ---------------------------------------------------------------------------

  const MAX_EXPR_LENGTH = 4000;

  function tokenize(input) {
    const tokens = [];
    let i = 0;
    const s = String(input);
    if (s.length > MAX_EXPR_LENGTH) throw new Error("Expression too long");
    while (i < s.length) {
      const ch = s[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i += 1;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(s[i + 1] || ""))) {
        let j = i;
        while (j < s.length && /[0-9._]/.test(s[j])) j += 1;
        tokens.push({ type: "number", value: parseFloat(s.slice(i, j).replace(/_/g, "")) });
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        let out = "";
        while (j < s.length && s[j] !== ch) {
          if (s[j] === "\\" && j + 1 < s.length) {
            out += s[j + 1];
            j += 2;
          } else {
            out += s[j];
            j += 1;
          }
        }
        if (j >= s.length) throw new Error("Unterminated string in expression");
        tokens.push({ type: "string", value: out });
        i = j + 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j += 1;
        const word = s.slice(i, j);
        if (word === "true") tokens.push({ type: "boolean", value: true });
        else if (word === "false") tokens.push({ type: "boolean", value: false });
        else if (word === "null") tokens.push({ type: "null", value: null });
        else tokens.push({ type: "ident", value: word });
        i = j;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||" || two === "[]") {
        tokens.push({ type: "op", value: two });
        i += 2;
        continue;
      }
      if ("+-*/%<>!?:.,()[]|".includes(ch)) {
        tokens.push({ type: "op", value: ch });
        i += 1;
        continue;
      }
      throw new Error("Unexpected character in expression: " + ch);
    }
    tokens.push({ type: "eof", value: null });
    return tokens;
  }

  function parseExpression(input) {
    const tokens = tokenize(input);
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expectOp = (value) => {
      const token = next();
      if (token.type !== "op" || token.value !== value) throw new Error("Expected '" + value + "' in expression");
    };
    const atOp = (value) => peek().type === "op" && peek().value === value;

    function parsePipe() {
      let node = parseTernary();
      while (atOp("|")) {
        next();
        const name = next();
        if (name.type !== "ident") throw new Error("Formatter name expected after '|'");
        const args = [];
        if (atOp("(")) {
          next();
          if (!atOp(")")) {
            args.push(parsePipe());
            while (atOp(",")) {
              next();
              args.push(parsePipe());
            }
          }
          expectOp(")");
        }
        node = { type: "format", name: name.value, input: node, args };
      }
      return node;
    }

    function parseTernary() {
      const test = parseOr();
      if (atOp("?")) {
        next();
        const consequent = parsePipe();
        expectOp(":");
        const alternate = parsePipe();
        return { type: "ternary", test, consequent, alternate };
      }
      return test;
    }

    function parseBinaryLevel(ops, nextLevel) {
      let left = nextLevel();
      while (peek().type === "op" && ops.includes(peek().value)) {
        const op = next().value;
        const right = nextLevel();
        left = { type: "binary", op, left, right };
      }
      return left;
    }

    const parseOr = () => parseBinaryLevel(["||"], parseAnd);
    const parseAnd = () => parseBinaryLevel(["&&"], parseEquality);
    const parseEquality = () => parseBinaryLevel(["==", "!="], parseRelational);
    const parseRelational = () => parseBinaryLevel(["<", ">", "<=", ">="], parseAdditive);
    const parseAdditive = () => parseBinaryLevel(["+", "-"], parseMultiplicative);
    const parseMultiplicative = () => parseBinaryLevel(["*", "/", "%"], parseUnary);

    function parseUnary() {
      if (atOp("!") || atOp("-")) {
        const op = next().value;
        return { type: "unary", op, operand: parseUnary() };
      }
      return parsePostfix();
    }

    function parsePostfix() {
      let node = parsePrimary();
      for (;;) {
        if (atOp(".")) {
          next();
          const name = next();
          if (name.type !== "ident") throw new Error("Property name expected after '.'");
          if (node.type === "mapchain") node.chain.push({ kind: "member", property: name.value });
          else node = { type: "member", object: node, property: name.value };
        } else if (atOp("[]")) {
          next();
          if (node.type === "mapchain") node.chain.push({ kind: "flatmap" });
          else node = { type: "mapchain", object: node, chain: [] };
        } else if (atOp("[")) {
          next();
          const index = parsePipe();
          expectOp("]");
          if (node.type === "mapchain") node.chain.push({ kind: "index", index });
          else node = { type: "index", object: node, index };
        } else if (atOp("(")) {
          if (node.type !== "path_root") throw new Error("Only whitelisted functions can be called");
          next();
          const args = [];
          if (!atOp(")")) {
            args.push(parsePipe());
            while (atOp(",")) {
              next();
              args.push(parsePipe());
            }
          }
          expectOp(")");
          node = { type: "call", name: node.name, args };
        } else {
          break;
        }
      }
      return node;
    }

    function parsePrimary() {
      const token = next();
      if (token.type === "number" || token.type === "string" || token.type === "boolean" || token.type === "null") {
        return { type: "literal", value: token.value };
      }
      if (token.type === "ident") return { type: "path_root", name: token.value };
      if (token.type === "op" && token.value === "(") {
        const inner = parsePipe();
        expectOp(")");
        return inner;
      }
      throw new Error("Unexpected token in expression");
    }

    const ast = parsePipe();
    if (peek().type !== "eof") throw new Error("Unexpected trailing content in expression");
    return ast;
  }

  const EXPR_FUNCTIONS = {
    sum: (values) => (Array.isArray(values) ? values.reduce((acc, v) => acc + (Number(v) || 0), 0) : Number(values) || 0),
    count: (values) => (Array.isArray(values) ? values.length : values === null || values === undefined ? 0 : 1),
    min: (...args) => Math.min(...flattenNumbers(args)),
    max: (...args) => Math.max(...flattenNumbers(args)),
    round: (value, dp) => {
      const f = Math.pow(10, dp || 0);
      return Math.round((Number(value) || 0) * f) / f;
    },
    floor: (value) => Math.floor(Number(value) || 0),
    ceil: (value) => Math.ceil(Number(value) || 0),
    abs: (value) => Math.abs(Number(value) || 0),
    coalesce: (...args) => args.find((v) => v !== null && v !== undefined && v !== ""),
    concat: (...args) => args.map((v) => (v === null || v === undefined ? "" : String(v))).join(""),
    join: (values, sep) => (Array.isArray(values) ? values.filter((v) => v !== null && v !== undefined && v !== "").join(sep === undefined ? ", " : sep) : ""),
    length: (value) => (value === null || value === undefined ? 0 : Array.isArray(value) || typeof value === "string" ? value.length : Object.keys(value).length),
    contains: (haystack, needle) => {
      if (Array.isArray(haystack)) return haystack.includes(needle);
      if (typeof haystack === "string") return haystack.includes(String(needle));
      return false;
    },
    filter_by: (values, prop, expected) => (Array.isArray(values) ? values.filter((v) => getPath(v, prop) === expected) : []),
    // Timing helpers for conditional pricing (early-signing discounts,
    // expiring line items). Missing/invalid dates yield Infinity so
    // "days_since(doc.sent_at) < 7" is FALSE until the document is sent.
    days_since: (value) => {
      const date = parseDateValue(value);
      return date ? (Date.now() - date.getTime()) / 86400000 : Infinity;
    },
    hours_since: (value) => {
      const date = parseDateValue(value);
      return date ? (Date.now() - date.getTime()) / 3600000 : Infinity;
    },
    first: (values) => (Array.isArray(values) ? values[0] : values),
    last: (values) => (Array.isArray(values) ? values[values.length - 1] : values),
    if: (cond, a, b) => (cond ? a : b),
    not_empty: (value) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)
  };

  function flattenNumbers(args) {
    const out = [];
    for (const arg of args) {
      if (Array.isArray(arg)) for (const v of arg) out.push(Number(v) || 0);
      else out.push(Number(arg) || 0);
    }
    return out.length ? out : [0];
  }

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function parseDateValue(value) {
    if (value === null || value === undefined || value === "") return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === "number") return new Date(value);
    const str = String(value);
    // Date-only strings are treated as local dates, not UTC midnight.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const date = new Date(str);
    return isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, pattern) {
    const date = parseDateValue(value);
    if (!date) return "";
    const fmt = pattern || "MMM d, yyyy";
    const pad = (n) => String(n).padStart(2, "0");
    const hours12 = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12;
    return fmt.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|hh|h|mm|a/g, (token) => {
      switch (token) {
        case "yyyy": return String(date.getFullYear());
        case "yy": return String(date.getFullYear()).slice(-2);
        case "MMMM": return MONTHS[date.getMonth()];
        case "MMM": return MONTHS[date.getMonth()].slice(0, 3);
        case "MM": return pad(date.getMonth() + 1);
        case "M": return String(date.getMonth() + 1);
        case "dd": return pad(date.getDate());
        case "d": return String(date.getDate());
        case "HH": return pad(date.getHours());
        case "hh": return pad(hours12);
        case "h": return String(hours12);
        case "mm": return pad(date.getMinutes());
        case "a": return date.getHours() < 12 ? "AM" : "PM";
        default: return token;
      }
    });
  }

  function formatMoney(cents, currency, locale) {
    const amount = (Number(cents) || 0) / 100;
    try {
      return new Intl.NumberFormat(locale || "en-US", { style: "currency", currency: currency || "USD" }).format(amount);
    } catch (error) {
      return "$" + amount.toFixed(2);
    }
  }

  const FORMATTERS = {
    money: (value, currency, locale) => formatMoney(value, currency, locale),
    number: (value, dp, locale) => {
      const num = Number(value) || 0;
      try {
        return new Intl.NumberFormat(locale || "en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp === undefined ? 2 : dp }).format(num);
      } catch (error) {
        return String(num);
      }
    },
    percent: (value, dp) => ((Number(value) || 0)).toFixed(dp === undefined ? 0 : dp) + "%",
    date: (value, pattern) => formatDate(value, pattern),
    datetime: (value) => formatDate(value, "MMM d, yyyy h:mm a"),
    upper: (value) => String(value === null || value === undefined ? "" : value).toUpperCase(),
    lower: (value) => String(value === null || value === undefined ? "" : value).toLowerCase(),
    title: (value) => String(value === null || value === undefined ? "" : value).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
    trim: (value) => String(value === null || value === undefined ? "" : value).trim(),
    qty: (value, unit) => {
      const num = Number(value) || 0;
      const rendered = Number.isInteger(num) ? String(num) : num.toFixed(2);
      return unit ? rendered + " " + unit : rendered;
    },
    phone: (value) => {
      const digits = String(value || "").replace(/\D/g, "");
      if (digits.length === 10) return "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6);
      if (digits.length === 11 && digits[0] === "1") return "(" + digits.slice(1, 4) + ") " + digits.slice(4, 7) + "-" + digits.slice(7);
      return String(value || "");
    },
    initials: (value) => String(value || "").split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).slice(0, 3).join(""),
    default: (value, fallback) => (value === null || value === undefined || value === "" ? fallback : value),
    json: (value) => JSON.stringify(value)
  };

  function evaluateAst(ast, scope) {
    switch (ast.type) {
      case "literal":
        return ast.value;
      case "path_root": {
        if (UNSAFE_KEYS.has(ast.name)) return undefined;
        return scope ? scope[ast.name] : undefined;
      }
      case "member": {
        if (UNSAFE_KEYS.has(ast.property)) return undefined;
        const object = evaluateAst(ast.object, scope);
        if (object === null || object === undefined) return undefined;
        return object[ast.property];
      }
      case "index": {
        const object = evaluateAst(ast.object, scope);
        const index = evaluateAst(ast.index, scope);
        if (object === null || object === undefined) return undefined;
        if (typeof index === "string" && UNSAFE_KEYS.has(index)) return undefined;
        return object[index];
      }
      case "mapchain": {
        // params.items[].amount_cents — map remaining accessors over the array.
        const object = evaluateAst(ast.object, scope);
        let items = Array.isArray(object) ? object : object === null || object === undefined ? [] : [object];
        for (const segment of ast.chain) {
          if (segment.kind === "member") {
            if (UNSAFE_KEYS.has(segment.property)) return [];
            items = items.map((el) => (el === null || el === undefined ? undefined : el[segment.property]));
          } else if (segment.kind === "index") {
            const index = evaluateAst(segment.index, scope);
            if (typeof index === "string" && UNSAFE_KEYS.has(index)) return [];
            items = items.map((el) => (el === null || el === undefined ? undefined : el[index]));
          } else if (segment.kind === "flatmap") {
            const flat = [];
            for (const el of items) {
              if (Array.isArray(el)) flat.push(...el);
              else if (el !== null && el !== undefined) flat.push(el);
            }
            items = flat;
          }
        }
        return items;
      }
      case "call": {
        const fn = EXPR_FUNCTIONS[ast.name];
        if (!fn) throw new Error("Unknown expression function: " + ast.name);
        const args = ast.args.map((arg) => evaluateAst(arg, scope));
        return fn(...args);
      }
      case "format": {
        const fn = FORMATTERS[ast.name];
        if (!fn) throw new Error("Unknown formatter: " + ast.name);
        const input = evaluateAst(ast.input, scope);
        const args = ast.args.map((arg) => evaluateAst(arg, scope));
        return fn(input, ...args);
      }
      case "unary": {
        const value = evaluateAst(ast.operand, scope);
        return ast.op === "!" ? !truthy(value) : -(Number(value) || 0);
      }
      case "binary": {
        // "map" propagation: number ops over arrays are intentionally NOT
        // supported; use sum()/count() etc. Keeps semantics predictable.
        const left = evaluateAst(ast.left, scope);
        if (ast.op === "&&") return truthy(left) ? evaluateAst(ast.right, scope) : left;
        if (ast.op === "||") return truthy(left) ? left : evaluateAst(ast.right, scope);
        const right = evaluateAst(ast.right, scope);
        switch (ast.op) {
          case "+":
            if (typeof left === "string" || typeof right === "string") return String(left === null || left === undefined ? "" : left) + String(right === null || right === undefined ? "" : right);
            return (Number(left) || 0) + (Number(right) || 0);
          case "-": return (Number(left) || 0) - (Number(right) || 0);
          case "*": return (Number(left) || 0) * (Number(right) || 0);
          case "/": return (Number(right) || 0) === 0 ? 0 : (Number(left) || 0) / Number(right);
          case "%": return (Number(right) || 0) === 0 ? 0 : (Number(left) || 0) % Number(right);
          case "==": return looseEquals(left, right);
          case "!=": return !looseEquals(left, right);
          case "<": return compare(left, right) < 0;
          case ">": return compare(left, right) > 0;
          case "<=": return compare(left, right) <= 0;
          case ">=": return compare(left, right) >= 0;
          default: throw new Error("Unknown operator: " + ast.op);
        }
      }
      case "ternary":
        return truthy(evaluateAst(ast.test, scope)) ? evaluateAst(ast.consequent, scope) : evaluateAst(ast.alternate, scope);
      default:
        throw new Error("Unknown expression node: " + ast.type);
    }
  }

  function truthy(value) {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  }

  function looseEquals(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined || b === "";
    if (b === null || b === undefined) return a === "";
    if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
    return a === b;
  }

  function compare(a, b) {
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    const na = Number(a) || 0;
    const nb = Number(b) || 0;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }

  const astCache = new Map();
  const AST_CACHE_LIMIT = 500;

  function compiledAst(expr) {
    if (astCache.has(expr)) return astCache.get(expr);
    const ast = parseExpression(expr);
    if (astCache.size >= AST_CACHE_LIMIT) astCache.clear();
    astCache.set(expr, ast);
    return ast;
  }

  /** Evaluate a bare expression string against a scope. Returns undefined on missing paths; throws on syntax errors. */
  function evaluate(expr, scope) {
    return evaluateAst(compiledAst(String(expr)), scope || {});
  }

  /** Evaluate, swallowing errors (render paths use this; validation uses evaluate/parseExpression). */
  function evaluateSafe(expr, scope, fallback) {
    try {
      const value = evaluate(expr, scope);
      return value === undefined ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  const INTERPOLATION_PATTERN = /\{\{([\s\S]+?)\}\}/g;

  /** True if the string contains any {{...}} tokens. */
  function hasInterpolation(value) {
    return typeof value === "string" && value.includes("{{");
  }

  /**
   * Interpolate {{expr}} tokens in a string. A string that is exactly one
   * token returns the raw evaluated value (preserving numbers/arrays/objects);
   * mixed content always returns a string.
   */
  function interpolate(template, scope) {
    if (typeof template !== "string") return template;
    // Exact single token ("{{expr}}" and nothing else) returns the raw value.
    // Guard against regex backtracking treating "{{a}} x {{b}}" as one token:
    // the inner content must not itself contain token delimiters.
    const trimmed = template.trim();
    if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
      const inner = trimmed.slice(2, -2);
      if (!inner.includes("{{") && !inner.includes("}}")) {
        return evaluateSafe(inner.trim(), scope, undefined);
      }
    }
    return template.replace(INTERPOLATION_PATTERN, (_match, inner) => {
      const value = evaluateSafe(inner.trim(), scope, "");
      return value === null || value === undefined ? "" : String(value);
    });
  }

  // ---------------------------------------------------------------------------
  // Binding resolution
  //
  // resolveBindings() produces a render-ready document: computed values are
  // evaluated, bind.if prunes nodes, bind.repeat clones them, bind.props and
  // text-run bindings/interpolations are applied. Widget nodes keep their
  // config (widget data is resolved by the widget registry, not here) but
  // their config values ARE interpolated.
  // ---------------------------------------------------------------------------

  function buildScope(data, extra) {
    const scope = {
      params: (data && data.params) || {},
      outputs: (data && data.outputs) || {},
      computed: (data && data.computed) || {},
      theme: (data && data.theme) || {},
      org: (data && data.org) || {},
      project: (data && data.project) || {},
      customer: (data && data.customer) || {},
      doc: (data && data.doc) || {},
      now: (data && data.now) || new Date().toISOString()
    };
    if (extra) for (const key of Object.keys(extra)) scope[key] = extra[key];
    return scope;
  }

  function resolveComputed(computedDefs, scope) {
    const resolved = {};
    const defs = computedDefs || {};
    scope.computed = resolved;
    // Two passes let computed values reference each other one level deep
    // without a dependency graph; deeper chains resolve on the second pass.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const key of Object.keys(defs)) {
        const value = evaluateSafe(String(defs[key]), scope, undefined);
        if (value !== undefined) resolved[key] = value;
      }
    }
    return resolved;
  }

  function resolveValueDeep(value, scope) {
    if (typeof value === "string") return hasInterpolation(value) ? interpolate(value, scope) : value;
    if (Array.isArray(value)) return value.map((v) => resolveValueDeep(v, scope));
    if (isObject(value)) {
      const out = {};
      for (const key of Object.keys(value)) out[key] = resolveValueDeep(value[key], scope);
      return out;
    }
    return value;
  }

  function evaluateListExpr(expr, scope) {
    const value = typeof expr === "string" && hasInterpolation(expr) ? interpolate(expr, scope) : evaluateSafe(String(expr), scope, []);
    return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  }

  /**
   * Instantiate a component definition for one input row. Returns the
   * resolved root subtree (frame merged from the ref node when supplied).
   */
  function instantiateComponent(def, input, scope, ctx, idBase) {
    const variantName = input && input.__variant;
    let root = deepClone(def.root || null);
    if (!root) return [];
    if (variantName && def.variants && def.variants[variantName]) root = deepMerge(root, def.variants[variantName]);
    const extra = {};
    const paramDefs = def.params || {};
    for (const key of Object.keys(paramDefs)) {
      const raw = input ? input[key] : undefined;
      extra[key] = typeof raw === "string" && hasInterpolation(raw) ? interpolate(raw, scope) : raw !== undefined ? resolveValueDeep(raw, scope) : paramDefaultValue(paramDefs[key]);
    }
    const instScope = Object.assign({}, scope, extra);
    const renamed = reassignIdsWithBase(root, idBase);
    return resolveNode(renamed, instScope, ctx);
  }

  /**
   * Fit a resolved component subtree to the width assigned by its instance.
   * Component definitions use local point coordinates, so changing only the
   * root width leaves headers/totals and their inner columns at the old size.
   * Scaling horizontal local geometry keeps every related piece aligned while
   * preserving font sizes and vertical rhythm.
   */
  function fitComponentWidth(roots, sourceWidth, targetWidth) {
    const from = Number(sourceWidth);
    const to = Number(targetWidth);
    if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0 || Math.abs(from - to) < 0.01) return roots;
    const ratio = to / from;
    const scale = (node, isRoot) => {
      if (!node || !node.frame) return;
      if (isRoot) {
        node.frame.w = to;
      } else {
        if (typeof node.frame.x === "number") node.frame.x *= ratio;
        if (typeof node.frame.w === "number") node.frame.w *= ratio;
      }
      for (const child of node.children || []) scale(child, false);
    };
    for (const root of roots || []) scale(root, true);
    return roots;
  }

  /** Deterministic id remap for component instances (idBase + local path). */
  function reassignIdsWithBase(fragment, idBase) {
    const clone = deepClone(fragment);
    let counter = 0;
    const visit = (node) => {
      node.id = idBase + "_" + (counter++).toString(36);
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(clone);
    return clone;
  }

  function resolveNode(node, scope, ctx) {
    ctx = ctx || { components: {} };
    const bind = node.bind || {};
    if (bind.if !== undefined && bind.if !== null && bind.if !== "") {
      const cond = typeof bind.if === "string" && hasInterpolation(bind.if) ? interpolate(bind.if, scope) : evaluateSafe(String(bind.if), scope, false);
      if (!truthy(cond)) return [];
    }
    if (bind.repeat && bind.repeat.for) {
      const forExpr = bind.repeat.for;
      const list = evaluateListExpr(forExpr, scope);
      const as = bind.repeat.as || "item";
      const indexAs = bind.repeat.index_as || "index";
      const out = [];
      for (let i = 0; i < list.length; i += 1) {
        const child = deepClone(node);
        child.id = node.id + "__r" + i;
        child.bind = Object.assign({}, bind, { repeat: null });
        const extra = {};
        extra[as] = list[i];
        extra[indexAs] = i;
        const childScope = Object.assign({}, scope, extra);
        out.push(...resolveNode(child, childScope, ctx));
      }
      return out;
    }

    // Component instance: inline the def's subtree at the ref's frame.
    // Detached instances carry their fork in node.children and resolve like
    // a plain frame below.
    if (node.type === "component_ref" && !(node.props && node.props.detached)) {
      const name = node.props && node.props.component;
      const def = name ? ctx.components[name] : null;
      if (!def) {
        const missing = deepClone(node);
        missing.bind = null;
        missing.resolved_component_missing = true;
        return [missing];
      }
      const input = Object.assign({}, resolveValueDeep((node.props && node.props.input) || {}, scope));
      if (node.props && node.props.variant) input.__variant = node.props.variant;
      const roots = instantiateComponent(def, input, scope, ctx, node.id);
      fitComponentWidth(roots, roots[0] && roots[0].frame && roots[0].frame.w, node.frame && node.frame.w);
      return roots.map((root) => {
        const inst = root;
        inst.frame = deepMerge(inst.frame || {}, deepClone(node.frame || {}));
        inst.anchor = node.anchor || inst.anchor;
        inst.component = String(name); // editor badge + edit-component entry point
        inst.component_ref_id = node.id;
        return inst;
      });
    }

    // Repeater: source list × component def -> resolved instances as children.
    // The repeater node itself survives (layout + break_rules drive the
    // renderer's page-breaking).
    if (node.type === "repeater") {
      const resolvedRep = deepClone(node);
      resolvedRep.bind = null;
      const name = node.props && node.props.component;
      const def = name ? ctx.components[name] : null;
      const list = node.props && node.props.source ? evaluateListExpr(node.props.source, scope) : [];
      const as = (node.props && node.props.as) || "row";
      const indexAs = (node.props && node.props.index_as) || "index";
      const children = [];
      // Alternating layouts (media-left / media-right rows): cycle variants
      // by row index. Per-row layout fields override the cycle.
      const variantCycle = Array.isArray(node.props && node.props.variant_by_index) ? node.props.variant_by_index.filter(Boolean) : null;
      if (def) {
        for (let i = 0; i < list.length; i += 1) {
          const extra = {};
          extra[as] = list[i];
          extra[indexAs] = i;
          const rowScope = Object.assign({}, scope, extra);
          const input = { __row: list[i] };
          for (const key of Object.keys(def.params || {})) input[key] = list[i] && list[i][key] !== undefined ? list[i][key] : list[i];
          const rowVariant = list[i] && typeof list[i] === "object" ? list[i].variant || list[i].layout : null;
          if (rowVariant && def.variants && def.variants[rowVariant]) input.__variant = rowVariant;
          else if (variantCycle && variantCycle.length) input.__variant = variantCycle[i % variantCycle.length];
          else if (node.props && node.props.variant) input.__variant = node.props.variant;
          const roots = instantiateComponent(def, input, rowScope, ctx, node.id + "__i" + i);
          const columns = Math.max(1, Number(node.props && node.props.layout && node.props.layout.columns) || 1);
          const gap = Number(node.props && node.props.layout && node.props.layout.gap_pt);
          const repeaterWidth = Number(node.frame && node.frame.w);
          const instanceWidth = Number.isFinite(repeaterWidth)
            ? Math.max(1, (repeaterWidth - (Number.isFinite(gap) ? gap : 6) * (columns - 1)) / columns)
            : null;
          fitComponentWidth(roots, roots[0] && roots[0].frame && roots[0].frame.w, instanceWidth);
          for (const inst of roots) {
            inst.component = String(name);
            inst.repeater_index = i;
            children.push(inst);
          }
        }
      }
      resolvedRep.children = children;
      resolvedRep.props = resolvedRep.props || {};
      resolvedRep.props.resolved_count = children.length;
      return [resolvedRep];
    }

    const resolved = deepClone(node);
    resolved.bind = null;

    if (bind.props && isObject(bind.props)) {
      for (const prop of Object.keys(bind.props)) {
        const raw = bind.props[prop];
        const value = typeof raw === "string" ? interpolate(raw, scope) : resolveValueDeep(raw, scope);
        setPath(resolved, prop, value);
      }
    }

    if (resolved.type === "text" && resolved.props && Array.isArray(resolved.props.blocks)) {
      for (const block of resolved.props.blocks) {
        if (!Array.isArray(block.runs)) continue;
        for (const run of block.runs) {
          if (run.bind) {
            const value = typeof run.bind === "string" ? interpolate(hasInterpolation(run.bind) ? run.bind : "{{" + run.bind + "}}", scope) : undefined;
            run.text = value === null || value === undefined ? "" : String(value);
            run.bound = true;
            delete run.bind;
          } else if (hasInterpolation(run.text)) {
            const value = interpolate(run.text, scope);
            run.text = value === null || value === undefined ? "" : String(value);
          }
        }
      }
    }

    if (resolved.type === "widget" && resolved.props) {
      resolved.props.config = resolveValueDeep(resolved.props.config || {}, scope);
    }

    if (Array.isArray(resolved.children)) {
      const children = [];
      for (const child of resolved.children) children.push(...resolveNode(child, scope, ctx));
      resolved.children = children;
    }

    return [resolved];
  }

  /**
   * Resolve a document against data: { params, outputs, theme, org, project,
   * customer, doc }. Returns a new document with computed values materialized
   * (doc.computed_values), conditions applied, repeats expanded, and all text
   * bindings interpolated. Widget nodes still require registry data
   * resolution before/at render.
   */
  function resolveBindings(document, data) {
    const doc = deepClone(document);
    const scope = buildScope(data);
    scope.computed = resolveComputed(doc.computed, scope);
    doc.computed_values = deepClone(scope.computed);
    // Component defs available during resolution: the document's own plus any
    // the caller merged in (server merges template + org library defs into
    // data.components before resolving).
    const ctx = { components: Object.assign({}, (data && data.components) || {}, doc.components || {}) };

    if (doc.kind === "view") {
      if (doc.root) {
        const roots = resolveNode(doc.root, scope, ctx);
        doc.root = roots[0] || null;
      }
      return doc;
    }

    const pages = [];
    for (const page of doc.pages || []) {
      const instances = [];
      if (page.repeat && page.repeat.for) {
        const items = interpolate(String(page.repeat.for), scope);
        const list = Array.isArray(items) ? items : [];
        const as = page.repeat.as || "item";
        for (let i = 0; i < list.length; i += 1) {
          const clone = deepClone(page);
          clone.id = page.id + "__r" + i;
          clone.repeat = null;
          const extra = {};
          extra[as] = list[i];
          extra.page_index = i;
          instances.push({ page: clone, scope: Object.assign({}, scope, extra) });
        }
      } else {
        instances.push({ page: deepClone(page), scope });
      }
      for (const instance of instances) {
        const children = [];
        for (const child of instance.page.children || []) children.push(...resolveNode(child, instance.scope, ctx));
        instance.page.children = children;
        pages.push(instance.page);
      }
    }
    doc.pages = pages;
    return doc;
  }

  // ---------------------------------------------------------------------------
  // Named styles (block.style_ref resolution: doc.styles → theme.type_styles)
  // ---------------------------------------------------------------------------

  /**
   * Resolve a style ref to a flat style object. Precedence: doc.styles[ref]
   * over theme.type_styles[ref]; both merged so a doc style can override just
   * one property of the theme style. Returns {} for unknown refs.
   */
  function resolveStyleRef(styleRef, doc, theme) {
    const ref = String(styleRef || "").trim();
    if (!ref) return {};
    const themeStyle = theme && theme.type_styles && isObject(theme.type_styles[ref]) ? theme.type_styles[ref] : {};
    const docStyle = doc && doc.styles && isObject(doc.styles[ref]) ? doc.styles[ref] : {};
    return deepMerge(themeStyle, docStyle);
  }

  /** All style names visible to a document (doc overrides listed once). */
  function availableStyleRefs(doc, theme) {
    const names = new Set();
    for (const key of Object.keys((theme && theme.type_styles) || {})) names.add(key);
    for (const key of Object.keys((doc && doc.styles) || {})) names.add(key);
    return Array.from(names);
  }

  /** Merged component defs for a document (doc → template → libraries). */
  function mergedComponents(doc, ...extraSets) {
    const out = {};
    for (let i = extraSets.length - 1; i >= 0; i -= 1) {
      const set = extraSets[i];
      if (isObject(set)) for (const key of Object.keys(set)) out[key] = set[key];
    }
    const own = (doc && doc.components) || {};
    for (const key of Object.keys(own)) out[key] = own[key];
    return out;
  }

  // ---------------------------------------------------------------------------
  // Themes
  // ---------------------------------------------------------------------------

  const THEME_TOKEN_PREFIX = "--fm-";

  /**
   * Resolve theme tokens to a flat CSS-variable map.
   * context = { branding: { colors: {...} }, overrides: {...} }.
   * Token values may be literals or { from: "org.branding.colors.primary",
   * fallback: "#2563EB" } references resolved against { org: { branding } }.
   */
  function resolveThemeTokens(theme, context) {
    const ctx = context || {};
    const refScope = { org: { branding: ctx.branding || {} } };
    const vars = {};
    const tokens = (theme && theme.tokens) || {};

    const resolveTokenValue = (value) => {
      if (isObject(value) && value.from) {
        const resolved = getPath(refScope, value.from.replace(/^org\.branding\./, "org.branding."));
        return resolved !== undefined && resolved !== null && resolved !== "" ? resolved : value.fallback;
      }
      return value;
    };

    const colors = tokens.colors || {};
    for (const key of Object.keys(colors)) vars[THEME_TOKEN_PREFIX + "color-" + key.replace(/_/g, "-")] = String(resolveTokenValue(colors[key]) || "");
    const fonts = tokens.fonts || {};
    for (const key of Object.keys(fonts)) vars[THEME_TOKEN_PREFIX + "font-" + key.replace(/_/g, "-")] = String(resolveTokenValue(fonts[key]) || "");
    const spacing = tokens.spacing || {};
    for (const key of Object.keys(spacing)) vars[THEME_TOKEN_PREFIX + "space-" + key.replace(/_/g, "-")] = String(resolveTokenValue(spacing[key]) || "");

    // Convenience aliases used throughout templates.
    if (vars["--fm-color-primary"]) vars["--fm-primary"] = vars["--fm-color-primary"];
    if (vars["--fm-color-accent"]) vars["--fm-accent"] = vars["--fm-color-accent"];
    if (vars["--fm-color-text"]) vars["--fm-text"] = vars["--fm-color-text"];
    if (vars["--fm-font-body"]) vars["--fm-body-font"] = vars["--fm-font-body"];
    if (vars["--fm-font-display"]) vars["--fm-display-font"] = vars["--fm-font-display"];

    const overrides = ctx.overrides || {};
    for (const key of Object.keys(overrides)) {
      const name = key.startsWith("--") ? key : THEME_TOKEN_PREFIX + key.replace(/_/g, "-");
      vars[name] = String(overrides[key]);
    }
    return vars;
  }

  function themeCssText(vars, selector) {
    const lines = Object.keys(vars || {}).map((name) => "  " + name + ": " + vars[name] + ";");
    return (selector || ":root") + " {\n" + lines.join("\n") + "\n}";
  }

  /** Pick the page master from a theme matching a page role. */
  function pageMasterForRole(theme, role) {
    const masters = (theme && theme.page_masters) || [];
    let fallback = null;
    for (const master of masters) {
      const match = master.match || {};
      if (match.role === role) return master;
      if (match.role === "*" || match.role === undefined) fallback = fallback || master;
    }
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // Params & outputs
  // ---------------------------------------------------------------------------

  const PARAM_TYPES = ["string", "text", "number", "currency", "percent", "date", "datetime", "boolean", "email", "phone", "address", "select", "multi_select", "media", "signature_request", "list", "object", "entity", "pricebook_line", "measurements", "payment_schedule"];
  const OUTPUT_TYPES = ["signature", "payment", "select", "form_values", "value"];

  function paramDefaultValue(def) {
    if (!def) return null;
    if (def.default !== undefined) return deepClone(def.default);
    switch (def.type) {
      case "number": case "currency": case "percent": return 0;
      case "boolean": return false;
      case "list": case "multi_select": return [];
      case "object": case "address": return {};
      default: return null;
    }
  }

  function missingRequiredParams(paramDefs, values) {
    const missing = [];
    const defs = paramDefs || {};
    for (const key of Object.keys(defs)) {
      const def = defs[key];
      if (!def || !def.required) continue;
      const value = values ? values[key] : undefined;
      const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
      if (empty) missing.push(key);
    }
    return missing;
  }

  /** Type-aware check that a recorded output value actually satisfies its
   *  definition — a bare {} or empty string never counts as a signature or
   *  payment, regardless of which surface recorded it. */
  function outputValueSatisfies(def, value) {
    if (value === null || value === undefined) return false;
    if (isObject(value) && value.status === "pending") return false;
    const type = (def && def.type) || "";
    if (type === "signature") {
      if (!isObject(value)) return false;
      const name = String(value.text || value.signer_name || "").trim();
      const image = String(value.image_data || value.imageData || "").trim();
      return Boolean(name || image);
    }
    if (type === "payment") {
      if (!isObject(value)) return false;
      const amount = Number(value.amount_cents);
      return Boolean(String(value.payment_id || "").trim()
        || String(value.payment_method || value.method || "").trim()
        || (Number.isFinite(amount) && amount > 0));
    }
    if (type === "select") {
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (isObject(value)) {
        if (String(value.value ?? value.id ?? value.option_id ?? "").trim()) return true;
        // Selection-group picks: { selections: {...} } / { selected_ids: [] }
        // envelopes or a bare { group_id: item_id } map all count once any
        // pick beyond bookkeeping keys exists.
        if (isObject(value.selections) && Object.keys(value.selections).length) return true;
        if (Array.isArray(value.selected_ids) && value.selected_ids.length) return true;
        return Object.keys(value).some((key) => !["recorded_at", "evidence", "status", "selections", "selected_ids"].includes(key));
      }
      return Boolean(value);
    }
    if (type === "form_values") {
      if (!isObject(value)) return Boolean(value);
      // recorded_at / evidence are stamped onto every object output — they do
      // not count as submitted form content.
      return Object.keys(value).some((key) => key !== "recorded_at" && key !== "evidence");
    }
    return true;
  }

  function requiredOutputsSatisfied(outputDefs, outputValues, gate) {
    const defs = outputDefs || {};
    const values = outputValues || {};
    for (const key of Object.keys(defs)) {
      const def = defs[key];
      if (!def) continue;
      const requiredForGate = gate ? def.required_for === gate : Boolean(def.required);
      if (!requiredForGate) continue;
      if (!outputValueSatisfies(def, values[key])) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  function validateDocument(doc) {
    const errors = [];
    const push = (path, message) => errors.push({ path, message });

    if (!isObject(doc)) return { ok: false, errors: [{ path: "", message: (globalThis.PlatformLanguage?.text("doc-model","m_86b25bb1b4250e","Document must be an object") ?? "Document must be an object") }] };
    if (doc.schema_version !== SCHEMA_VERSION) push("schema_version", "Unsupported schema_version: " + doc.schema_version);
    if (!DOCUMENT_KINDS.includes(doc.kind)) push("kind", "Unknown document kind: " + doc.kind);
    if (doc.kind === "document" && !Array.isArray(doc.pages)) push("pages", "Paged documents require a pages array");
    if (doc.kind === "view" && !isObject(doc.root)) push("root", "View documents require a root node");

    const seen = new Set();
    if (Array.isArray(doc.pages)) {
      for (let i = 0; i < doc.pages.length; i += 1) {
        const page = doc.pages[i];
        if (!page.id) push("pages." + i + ".id", "Page is missing an id");
        else if (seen.has(page.id)) push("pages." + i + ".id", "Duplicate id: " + page.id);
        else seen.add(page.id);
      }
    }

    walkNodes(doc, (node, ctx) => {
      const at = ctx.path.join(".");
      if (!node.id) push(at + ".id", "Node is missing an id");
      else if (seen.has(node.id)) push(at + ".id", "Duplicate id: " + node.id);
      else seen.add(node.id);
      if (!NODE_TYPES.includes(node.type)) push(at + ".type", "Unknown node type: " + node.type);
      if (!isObject(node.frame)) push(at + ".frame", "Node is missing a frame");
      else {
        for (const dim of ["x", "y", "w", "h"]) {
          const value = node.frame[dim];
          if (typeof value !== "number" && value !== "auto") push(at + ".frame." + dim, "frame." + dim + " must be a number (or 'auto')");
        }
        if (node.frame.position !== undefined) {
          if (!isObject(node.frame.position)) push(at + ".frame.position", "frame.position must be an object");
          else if (node.frame.position.x !== undefined) {
            const xPosition = node.frame.position.x;
            if (!isObject(xPosition)) push(at + ".frame.position.x", "frame.position.x must be an object");
            else {
              if (!HORIZONTAL_POSITION_UNITS.includes(xPosition.unit)) push(at + ".frame.position.x.unit", "unit must be 'percent' or 'px'");
              if (!HORIZONTAL_POSITION_ANCHORS.includes(xPosition.anchor)) push(at + ".frame.position.x.anchor", "anchor must be 'left', 'center', or 'right'");
              if (typeof xPosition.value !== "number" || !Number.isFinite(xPosition.value)) push(at + ".frame.position.x.value", "value must be a finite number");
            }
          }
        }
        if (node.frame.responsive !== undefined) {
          if (!isObject(node.frame.responsive)) push(at + ".frame.responsive", "frame.responsive must be an object");
          else {
            if (!RESPONSIVE_RESIZE_MODES.includes(node.frame.responsive.mode)) push(at + ".frame.responsive.mode", "mode must be 'auto' or 'manual'");
            if (!RESPONSIVE_SIZE_UNITS.includes(node.frame.responsive.width)) push(at + ".frame.responsive.width", "width must be 'percent' or 'fixed'");
            if (!RESPONSIVE_HEIGHT_MODES.includes(node.frame.responsive.height)) push(at + ".frame.responsive.height", "height must be 'proportional' or 'fixed'");
          }
        }
      }
      if (node.type === "widget") {
        const ref = node.props && node.props.widget;
        if (!ref || typeof ref !== "string" || !/^[a-z0-9_.-]+@\d+$/.test(ref)) push(at + ".props.widget", "Widget nodes require a widget reference like 'doc.line_items@1'");
      }
      if (node.type === "component_ref") {
        const detached = Boolean(node.props && node.props.detached);
        if (!detached && !(node.props && typeof node.props.component === "string" && node.props.component)) {
          push(at + ".props.component", "component_ref nodes require a component name (or detached:true with children)");
        }
      }
      if (node.type === "repeater") {
        if (!(node.props && node.props.component)) push(at + ".props.component", "repeater nodes require a component name");
        if (!(node.props && node.props.source)) push(at + ".props.source", "repeater nodes require a source expression");
      }
      if (node.anchor !== undefined && node.anchor !== null) {
        const anchor = node.anchor;
        const valid = typeof anchor === "string" ? ANCHOR_KINDS.includes(anchor) : isObject(anchor) && Boolean(anchor.to_block);
        if (!valid) push(at + ".anchor", "anchor must be 'page' | 'flow' | 'inline' | { to_block, offset?, wrap? }");
      }
      // props.link (additive, contracts §10): any node may carry a link the
      // renderer turns into an anchor. Soft shape check only — unknown extra
      // keys are tolerated so hosts can annotate.
      if (node.props && node.props.link !== undefined && node.props.link !== null) {
        const link = node.props.link;
        const linkOk = isObject(link) &&
          (link.href === undefined || typeof link.href === "string") &&
          (link.page === undefined || typeof link.page === "string") &&
          (link.target === undefined || link.target === "_self" || link.target === "_blank");
        if (!linkOk) push(at + ".props.link", "link must be { href?, page?, target? } (target '_self' | '_blank')");
      }
      const mayHaveChildren = node.type === "frame" || node.type === "repeater" || (node.type === "component_ref" && node.props && node.props.detached);
      if (!mayHaveChildren && Array.isArray(node.children) && node.children.length) {
        push(at + ".children", "Only frame, repeater, and detached component_ref nodes may have children");
      }
      if (node.bind) {
        for (const key of ["if"]) {
          const expr = node.bind[key];
          if (typeof expr === "string" && expr && !hasInterpolation(expr)) {
            try {
              parseExpression(expr);
            } catch (error) {
              push(at + ".bind." + key, "Invalid expression: " + error.message);
            }
          }
        }
        if (node.bind.props && isObject(node.bind.props)) {
          for (const prop of Object.keys(node.bind.props)) {
            const raw = node.bind.props[prop];
            if (typeof raw === "string" && hasInterpolation(raw)) {
              try {
                let match;
                INTERPOLATION_PATTERN.lastIndex = 0;
                while ((match = INTERPOLATION_PATTERN.exec(raw))) parseExpression(match[1].trim());
              } catch (error) {
                push(at + ".bind.props." + prop, "Invalid expression: " + error.message);
              }
            }
          }
        }
      }
    });

    const params = doc.params || {};
    for (const key of Object.keys(params)) {
      const def = params[key];
      if (!def || !PARAM_TYPES.includes(def.type)) push("params." + key, "Unknown param type: " + (def && def.type));
    }
    const outputs = doc.outputs || {};
    for (const key of Object.keys(outputs)) {
      const def = outputs[key];
      if (!def || !OUTPUT_TYPES.includes(def.type)) push("outputs." + key, "Unknown output type: " + (def && def.type));
    }

    const computed = doc.computed || {};
    for (const key of Object.keys(computed)) {
      try {
        parseExpression(String(computed[key]));
      } catch (error) {
        push("computed." + key, "Invalid expression: " + error.message);
      }
    }

    const components = doc.components || {};
    for (const name of Object.keys(components)) {
      const def = components[name];
      if (!isObject(def) || !isObject(def.root)) push("components." + name, "Component definitions require a root node");
    }
    const chains = doc.chains || {};
    for (const name of Object.keys(chains)) {
      if (!isObject(chains[name])) push("chains." + name, "Chain definitions must be objects");
    }

    return { ok: errors.length === 0, errors };
  }

  /** Collect widget references used by a document: [{ id, version, node_id }]. */
  function widgetRefs(doc) {
    const refs = [];
    walkNodes(doc, (node) => {
      if (node.type !== "widget") return;
      const ref = node.props && node.props.widget;
      if (typeof ref !== "string") return;
      const at = ref.lastIndexOf("@");
      refs.push({ id: at === -1 ? ref : ref.slice(0, at), version: at === -1 ? 1 : Number(ref.slice(at + 1)) || 1, node_id: node.id });
    });
    return refs;
  }

  // ---------------------------------------------------------------------------
  // Geometry (shared by editor + renderer hit-testing)
  // ---------------------------------------------------------------------------

  function degToRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function rotatePoint(px, py, cx, cy, deg) {
    const rad = degToRad(deg);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  /** Axis-aligned bounding box of a (possibly rotated) frame. */
  function frameBounds(frame) {
    const w = typeof frame.w === "number" ? frame.w : 0;
    const h = typeof frame.h === "number" ? frame.h : 0;
    const rotation = frame.rotation || 0;
    if (!rotation) return { x: frame.x, y: frame.y, w, h };
    const cx = frame.x + w / 2;
    const cy = frame.y + h / 2;
    const corners = [
      rotatePoint(frame.x, frame.y, cx, cy, rotation),
      rotatePoint(frame.x + w, frame.y, cx, cy, rotation),
      rotatePoint(frame.x + w, frame.y + h, cx, cy, rotation),
      rotatePoint(frame.x, frame.y + h, cx, cy, rotation)
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: round2(minX), y: round2(minY), w: round2(Math.max(...xs) - minX), h: round2(Math.max(...ys) - minY) };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function pointInFrame(px, py, frame) {
    const rotation = frame.rotation || 0;
    let x = px;
    let y = py;
    if (rotation) {
      const cx = frame.x + (frame.w || 0) / 2;
      const cy = frame.y + (frame.h || 0) / 2;
      const p = rotatePoint(px, py, cx, cy, -rotation);
      x = p.x;
      y = p.y;
    }
    return x >= frame.x && x <= frame.x + (frame.w || 0) && y >= frame.y && y <= frame.y + (frame.h || 0);
  }

  // ---------------------------------------------------------------------------
  // Style helpers (shared CSS mapping — renderer is the primary consumer, the
  // editor uses the same mapping for parity between canvas and output)
  // ---------------------------------------------------------------------------

  function fillToCss(fill) {
    if (!fill) return "";
    if (typeof fill === "string") return fill;
    if (fill.type === "solid" || !fill.type) return fill.color || "";
    // Image fills (contracts §10) cannot be expressed as a single CSS string —
    // the renderer paints them (background-image / SVG pattern). CSS-string
    // callers get the declared fallback color so nothing breaks.
    if (fill.type === "image") return fill.fallback_color || "";
    if (fill.type === "linear") {
      const stops = (fill.stops || []).map((s) => s.color + " " + (s.at !== undefined ? s.at * 100 + "%" : "")).join(", ");
      return "linear-gradient(" + (fill.angle_deg !== undefined ? fill.angle_deg + "deg" : "180deg") + ", " + stops + ")";
    }
    if (fill.type === "radial") {
      const stops = (fill.stops || []).map((s) => s.color + " " + (s.at !== undefined ? s.at * 100 + "%" : "")).join(", ");
      return "radial-gradient(circle, " + stops + ")";
    }
    return "";
  }

  function filtersToCss(filters) {
    if (!filters) return "";
    const parts = [];
    if (filters.brightness !== undefined && filters.brightness !== 1) parts.push("brightness(" + filters.brightness + ")");
    if (filters.contrast !== undefined && filters.contrast !== 1) parts.push("contrast(" + filters.contrast + ")");
    if (filters.saturate !== undefined && filters.saturate !== 1) parts.push("saturate(" + filters.saturate + ")");
    if (filters.hue_rotate_deg) parts.push("hue-rotate(" + filters.hue_rotate_deg + "deg)");
    if (filters.grayscale) parts.push("grayscale(" + filters.grayscale + ")");
    if (filters.sepia) parts.push("sepia(" + filters.sepia + ")");
    if (filters.blur_px) parts.push("blur(" + filters.blur_px + "px)");
    if (filters.invert) parts.push("invert(" + filters.invert + ")");
    return parts.join(" ");
  }

  function fontToCss(font, baseFontPt) {
    if (!font) return {};
    const css = {};
    if (font.family) css["font-family"] = /[ ,]/.test(font.family) && !font.family.includes(",") ? '"' + font.family + '", sans-serif' : font.family;
    if (font.size_pt) css["font-size"] = font.size_pt + "pt";
    else if (baseFontPt) css["font-size"] = baseFontPt + "pt";
    if (font.weight) css["font-weight"] = String(font.weight);
    if (font.style) css["font-style"] = font.style;
    if (font.color) css.color = font.color;
    if (font.transform) css["text-transform"] = font.transform;
    return css;
  }

  /** Canonical responsive width contract for top-level website sections.
   * width_percent controls the share of the available website surface (after
   * editor rails/trays); max_width_px optionally caps that width. A missing
   * setting defaults to 100% capped at 1000px. Keeping this normalization in DocModel makes
   * editor chrome, drag handles, previews, and published rendering agree. */
  function normalizeSectionWidth(value) {
    const source = isObject(value) ? value : {};
    const percentValue = Number(source.width_percent);
    const maxValue = Number(source.max_width_px);
    return {
      width_percent: Math.round(Math.max(10, Math.min(100, Number.isFinite(percentValue) ? percentValue : 100)) * 10) / 10,
      max_enabled: source.max_enabled !== false,
      max_width_px: Math.round(Math.max(160, Math.min(3840, Number.isFinite(maxValue) ? maxValue : 1000)))
    };
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  return {
    SCHEMA_VERSION,
    NODE_TYPES,
    PAGE_ROLES,
    DOCUMENT_KINDS,
    PAPER_SIZES,
    EDITOR_PROFILES,
    LOCKABLE,
    OVERRIDE_OPS,
    PARAM_TYPES,
    OUTPUT_TYPES,
    ANCHOR_KINDS,
    HORIZONTAL_POSITION_UNITS,
    HORIZONTAL_POSITION_ANCHORS,
    RESPONSIVE_RESIZE_MODES,
    RESPONSIVE_SIZE_UNITS,
    RESPONSIVE_HEIGHT_MODES,

    generateId,
    deepClone,
    deepMerge,
    getPath,
    setPath,

    createDocument,
    createBlankDocument,
    createPage,
    createNode,
    paperDimensions,

    documentRoots,
    walkNodes,
    findNode,
    findPage,
    insertNode,
    removeNode,
    collectIds,
    reassignIds,

    applyOverride,
    applyOverrides,

    parseExpression,
    evaluate,
    evaluateSafe,
    interpolate,
    hasInterpolation,
    formatters: FORMATTERS,
    expressionFunctions: EXPR_FUNCTIONS,

    buildScope,
    resolveBindings,
    resolveStyleRef,
    availableStyleRefs,
    mergedComponents,
    instantiateComponent,

    resolveThemeTokens,
    themeCssText,
    pageMasterForRole,

    paramDefaultValue,
    missingRequiredParams,
    requiredOutputsSatisfied,
    outputValueSatisfies,

    validateDocument,
    widgetRefs,

    degToRad,
    rotatePoint,
    frameBounds,
    rectsIntersect,
    pointInFrame,
    normalizeHorizontalPosition,
    horizontalPositionToLeft,
    horizontalPositionFromLeft,
    normalizeResponsiveResize,
    responsiveAutoRows,
    isMobileViewSection,
    desktopViewSection,
    mobileViewSection,
    activeViewSections,
    mobilizeViewSection,
    createMobileViewSection,
    linkMobileVariantSources,
    normalizeViewHorizontalPositions,

    fillToCss,
    filtersToCss,
    fontToCss,
    normalizeSectionWidth
  };
});
