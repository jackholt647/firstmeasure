/**
 * FirstMate Doc Editor — the visual document editor library of the FirstMate
 * document engine (global FMDocEditor).
 *
 * Implements docs/document-engine-contracts.md §4 exactly:
 *   - FMDocEditor.mount(container, opts) -> editor handle
 *   - command bus over FMDocModel ops (node.set / insert / remove / move /
 *     reorder / group / ungroup, page.*, doc.set, text.edit) with a
 *     200-entry undo log of inverse commands
 *   - edit-policy + per-node lock enforcement inside apply()
 *   - profiles (designer | document | fill | inline) as feature-flag presets
 *   - schema-driven inspector incl. the widget configPanel field DSL
 *   - renders THROUGH window.FMDocRenderer (contract §1) and decorates the
 *     rendered pages with its own overlay layer (selection, handles, guides)
 *
 * v2 (contract §9): mode system (visual | doc | preview) over the same bus +
 * undo stack; Doc mode = word-processor surface (contenteditable projection
 * over rendered flow chains, idle-commit + caret restore across repagination,
 * named-style dropdown, Insert menu, chain margins); Visual v2 = component
 * instance badges + "Edit component"/"Detach instance", anchor inspector,
 * chain link chrome, repeater inspector, page_break markers. New commands:
 * text.set_style_ref, text.split_block, text.merge_blocks, chain.set_defaults,
 * node.set_anchor, component.update_def, component.detach.
 *
 * Vanilla JS IIFE. No build step, no external dependencies. Depends on
 * FMDocModel (doc-model) for tree ops, geometry, expressions and cloning —
 * none of that is reimplemented here.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FMDocEditor = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const PX_PER_PT = 96 / 72; // CSS reference pixel per point
  const HISTORY_CAP = 200;
  const CHANGE_DEBOUNCE_MS = 400;
  const DOC_COMMIT_MS = 150; // doc-mode idle debounce before commit + repaginate
  const MODES = ["visual", "doc", "preview"];
  const NUDGE_PT = 1;
  const NUDGE_BIG_PT = 10;
  const DUPLICATE_OFFSET_PT = 10;
  const MIN_NODE_SIZE_PT = 4;
  const SNAP_TOLERANCE_PX = 6;
  const SECTION_WIDTH_SNAP_TOLERANCE_PX = 10;
  const ROTATE_SNAP_TOLERANCE_DEG = 4;
  const DRAG_THRESHOLD_PX = 3;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;

  function rectsOverlapVertically(a, b) {
    return Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
  }

  /** Canva-style equal-gap snapping on the horizontal axis. A candidate is
   *  valid only when the moving bounds vertically overlap both the middle
   *  element and the comparison element on its opposite side. */
  function equalSpacingSnap(bounds, candidates, tolerance) {
    if (!bounds || !Array.isArray(candidates)) return null;
    const limit = Math.max(0, Number(tolerance) || 0);
    let best = null;
    let bestAbs = limit + 1;
    for (const middle of candidates) {
      if (!middle || !rectsOverlapVertically(bounds, middle)) continue;
      const middleLeft = Number(middle.x);
      const middleRight = middleLeft + Number(middle.w);
      if (!Number.isFinite(middleLeft) || !Number.isFinite(middleRight)) continue;
      for (const comparison of candidates) {
        if (!comparison || comparison === middle || (comparison.id && middle.id && comparison.id === middle.id) || !rectsOverlapVertically(bounds, comparison)) continue;
        const comparisonLeft = Number(comparison.x);
        const comparisonRight = comparisonLeft + Number(comparison.w);
        if (!Number.isFinite(comparisonLeft) || !Number.isFinite(comparisonRight)) continue;
        let targetX = null;
        let startX = null;
        let endX = null;
        let referenceStartX = null;
        let referenceEndX = null;
        let gap = null;
        if (comparisonRight <= middleLeft) {
          gap = middleLeft - comparisonRight;
          targetX = middleRight + gap;
          startX = middleRight;
          endX = targetX;
          referenceStartX = comparisonRight;
          referenceEndX = middleLeft;
        } else if (comparisonLeft >= middleRight) {
          gap = comparisonLeft - middleRight;
          const targetRight = middleLeft - gap;
          targetX = targetRight - Number(bounds.w);
          startX = targetRight;
          endX = middleLeft;
          referenceStartX = middleRight;
          referenceEndX = comparisonLeft;
        }
        if (!(gap > 0) || !Number.isFinite(targetX)) continue;
        const dx = targetX - Number(bounds.x);
        const distance = Math.abs(dx);
        if (distance > limit || distance >= bestAbs) continue;
        const overlapTop = Math.max(Number(bounds.y), Number(middle.y));
        const overlapBottom = Math.min(Number(bounds.y) + Number(bounds.h), Number(middle.y) + Number(middle.h));
        const referenceOverlapTop = Math.max(Number(comparison.y), Number(middle.y));
        const referenceOverlapBottom = Math.min(Number(comparison.y) + Number(comparison.h), Number(middle.y) + Number(middle.h));
        bestAbs = distance;
        best = {
          dx: dx,
          gap: gap,
          startX: Math.min(startX, endX),
          endX: Math.max(startX, endX),
          y: (overlapTop + overlapBottom) / 2,
          referenceStartX: Math.min(referenceStartX, referenceEndX),
          referenceEndX: Math.max(referenceStartX, referenceEndX),
          referenceY: referenceOverlapBottom > referenceOverlapTop
            ? (referenceOverlapTop + referenceOverlapBottom) / 2
            : (overlapTop + overlapBottom) / 2,
          middleId: middle.id || null,
          comparisonId: comparison.id || null
        };
      }
    }
    return best;
  }

  /** Scale every descendant frame in group-local space. The outer group frame
   *  is supplied separately because its page-relative fixed edge is owned by
   *  the resize gesture. Responsive anchors are regenerated against each
   *  newly-scaled parent so pointer-up renders exactly like the live preview. */
  function scaleGroupedFrameTree(M, groupNode, nextGroupFrame, scaleX, scaleY, frameOverrides, responsive) {
    if (!M || !groupNode || !nextGroupFrame) return [];
    const sx = Number.isFinite(Number(scaleX)) ? Number(scaleX) : 1;
    const sy = Number.isFinite(Number(scaleY)) ? Number(scaleY) : 1;
    const overrides = frameOverrides && typeof frameOverrides === "object" ? frameOverrides : {};
    const parentWidths = new Map([[groupNode.id, Math.max(0.01, Number(nextGroupFrame.w) || 0.01)]]);
    const result = [];
    const visit = function (parent) {
      for (const child of parent.children || []) {
        const original = overrides[child.id]
          ? M.deepMerge(child.frame || {}, overrides[child.id])
          : M.deepClone(child.frame || {});
        const frame = Object.assign({}, original, {
          x: roundPt((Number(original.x) || 0) * sx),
          y: roundPt((Number(original.y) || 0) * sy),
          w: roundPt(Math.max(0.01, (Number(original.w) || 0) * sx)),
          h: roundPt(Math.max(0.01, (Number(original.h) || 0) * sy))
        });
        const parentWidth = parentWidths.get(parent.id);
        const position = original.position && original.position.x;
        if (responsive && position && parentWidth > 0 && typeof M.horizontalPositionFromLeft === "function") {
          frame.position = frame.position && typeof frame.position === "object" ? M.deepClone(frame.position) : {};
          frame.position.x = M.horizontalPositionFromLeft(
            frame.x * PX_PER_PT,
            frame.w * PX_PER_PT,
            parentWidth * PX_PER_PT,
            position
          );
        }
        result.push({ id: child.id, parent_id: parent.id, frame: frame });
        parentWidths.set(child.id, frame.w);
        visit(child);
      }
    };
    visit(groupNode);
    return result;
  }

  const FEATURE_KEYS = [
    "free_transform", "rotate", "resize", "shapes", "images", "filters",
    "text_style", "widget_insert", "page_manage", "group", "z_order",
    "theme_edit", "bind_edit", "unlock"
  ];

  // Profiles are presets over the feature-flag set (contract §4). The policy
  // (doc.edit_policy ∧ opts.editPolicy) can only further RESTRICT these.
  const PROFILE_FLAGS = {
    designer: {
      free_transform: true, rotate: true, resize: true, shapes: true,
      images: true, filters: true, text_style: true, widget_insert: true,
      page_manage: true, group: true, z_order: true, theme_edit: true,
      bind_edit: true, unlock: false
    },
    document: {
      // Day-to-day authoring: move/resize and z-order stay on so arranging a
      // page feels alive; rotation, shapes, and filters are designer-tier
      // (unlockable). Templates can still restrict further via edit_policy.
      free_transform: true, rotate: false, resize: true, shapes: false,
      images: true, filters: false, text_style: true, widget_insert: true,
      page_manage: true, group: true, z_order: true, theme_edit: false,
      bind_edit: false, unlock: true
    },
    fill: {
      // Only widget inputs + unlocked text content are editable.
      free_transform: false, rotate: false, resize: false, shapes: false,
      images: false, filters: false, text_style: false, widget_insert: false,
      page_manage: false, group: false, z_order: false, theme_edit: false,
      bind_edit: false, unlock: false
    },
    inline: {
      // Chromeless single surface: every movable object remains groupable.
      free_transform: true, rotate: true, resize: true, shapes: false,
      images: true, filters: true, text_style: true, widget_insert: false,
      page_manage: false, group: true, z_order: true, theme_edit: false,
      bind_edit: false, unlock: false
    }
  };

  const PROFILE_RANK = { fill: 0, inline: 1, document: 2, designer: 3 };
  const PROFILES = ["designer", "document", "fill", "inline"];

  const DEFAULT_FONTS = ["Inter", "Montserrat", "Georgia", "Arial", "Helvetica", "Times New Roman", "Courier New"];

  const FONT_WEIGHTS = [
    { value: "300", label: (globalThis.PlatformLanguage?.text("doc-editor","m_f7485e2ed9398f","Light") ?? "Light") },
    { value: "400", label: (globalThis.PlatformLanguage?.text("doc-editor","m_0901aad9a76ab1","Regular") ?? "Regular") },
    { value: "500", label: (globalThis.PlatformLanguage?.text("doc-editor","m_fbdb10c9b8040f","Medium") ?? "Medium") },
    { value: "600", label: (globalThis.PlatformLanguage?.text("doc-editor","m_8a644eed71141d","Semibold") ?? "Semibold") },
    { value: "700", label: (globalThis.PlatformLanguage?.text("doc-editor","m_4feeaa2c564c4a","Bold") ?? "Bold") },
    { value: "800", label: (globalThis.PlatformLanguage?.text("doc-editor","m_82287dc4908073","Extrabold") ?? "Extrabold") }
  ];

  const HANDLE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const HANDLE_VECTORS = {
    nw: { x: -1, y: -1 }, n: { x: 0, y: -1 }, ne: { x: 1, y: -1 },
    e: { x: 1, y: 0 }, se: { x: 1, y: 1 }, s: { x: 0, y: 1 },
    sw: { x: -1, y: 1 }, w: { x: -1, y: 0 }
  };

  const NODE_TYPE_LABELS = {
    frame: "Frame", text: "Text", image: "Image", shape: "Shape",
    widget: "Widget", markup_overlay: "Markup", table: "Table",
    component_ref: "Component", repeater: "Repeater", page_break: "Page break"
  };

  // ---------------------------------------------------------------------------
  // Icons — small inline SVG set (16x16, stroke = currentColor)
  // ---------------------------------------------------------------------------

  const SVG_OPEN = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const ICONS = {
    undo: '<path d="M6.2 2.8 2.8 6.2l3.4 3.4"/><path d="M2.8 6.2h6.7a3.7 3.7 0 0 1 0 7.4H6"/>',
    redo: '<path d="M9.8 2.8l3.4 3.4-3.4 3.4"/><path d="M13.2 6.2H6.5a3.7 3.7 0 0 0 0 7.4H10"/>',
    zoomin: '<circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14M7 5.2v3.6M5.2 7h3.6"/>',
    zoomout: '<circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14M5.2 7h3.6"/>',
    minus: '<path d="M3 8h10" stroke-width="1.8"/>',
    plusplain: '<path d="M8 3v10M3 8h10" stroke-width="1.8"/>',
    fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>',
    text: '<path d="M3.5 4.4V2.8h9v1.6M8 2.8v10.4M6 13.2h4"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.4"/><circle cx="5.6" cy="6.4" r="1.1"/><path d="M2.4 11.4 6 8.4l2.8 2.3 2.6-2 2.2 1.8"/>',
    rect: '<rect x="2.8" y="2.8" width="10.4" height="10.4" rx="1"/>',
    ellipse: '<circle cx="8" cy="8" r="5.4"/>',
    line: '<path d="M3 13 13 3"/>',
    polygon: '<path d="M8 2.6 14 13H2z"/>',
    frame: '<path d="M5 2v12M11 2v12M2 5h12M2 11h12"/>',
    widget: '<rect x="2.2" y="2.2" width="5" height="5" rx="1"/><rect x="8.8" y="2.2" width="5" height="5" rx="1"/><rect x="2.2" y="8.8" width="5" height="5" rx="1"/><rect x="8.8" y="8.8" width="5" height="5" rx="1"/>',
    pages: '<rect x="4.4" y="2" width="9" height="11" rx="1.2"/><path d="M2.6 5v8.4a1.6 1.6 0 0 0 1.6 1.6h7"/>',
    layers: '<path d="m8 2 6 3.2L8 8.4 2 5.2z"/><path d="m3 8.2 5 2.7 5-2.7M3 11.2l5 2.7 5-2.7"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    trash: '<path d="M3 4.4h10M6.4 4.4V3h3.2v1.4M4.2 4.4l.7 8.2a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-8.2M6.6 7v4M9.4 7v4"/>',
    copy: '<rect x="5.4" y="5.4" width="8" height="8" rx="1.2"/><path d="M10.6 5.4V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5.2A1.4 1.4 0 0 0 4 10.6h1.4"/>',
    group: '<rect x="2.4" y="2.4" width="7" height="7" rx="1"/><rect x="6.6" y="6.6" width="7" height="7" rx="1"/>',
    ungroup: '<rect x="2.2" y="2.2" width="5.4" height="5.4" rx="1"/><rect x="8.4" y="8.4" width="5.4" height="5.4" rx="1"/>',
    lock: '<rect x="3.6" y="7" width="8.8" height="6.6" rx="1.2"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
    unlock: '<rect x="3.6" y="7" width="8.8" height="6.6" rx="1.2"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5-1"/>',
    eye: '<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>',
    eyeoff: '<path d="M3 3l10 10M6.8 6.9a1.9 1.9 0 0 0 2.6 2.6M4.6 4.9C2.7 6.1 1.8 8 1.8 8s2.3 4.2 6.2 4.2a6.4 6.4 0 0 0 3.3-.9M9.9 4.1A6.5 6.5 0 0 0 8 3.8C4.1 3.8 1.8 8 1.8 8"/>',
    front: '<path d="M8 12V3M4.8 6.2 8 3l3.2 3.2M3 14h10"/>',
    back: '<path d="M8 4v9M4.8 9.8 8 13l3.2-3.2M3 2h10"/>',
    forward: '<path d="M8 13V4M4.6 7.4 8 4l3.4 3.4"/>',
    backward: '<path d="M8 3v9M4.6 8.6 8 12l3.4-3.4"/>',
    alignleft: '<path d="M2.5 2v12"/><rect x="4.4" y="3.6" width="8.6" height="3" rx=".8"/><rect x="4.4" y="9.4" width="5.2" height="3" rx=".8"/>',
    alignch: '<path d="M8 2v12"/><rect x="3" y="3.6" width="10" height="3" rx=".8"/><rect x="5" y="9.4" width="6" height="3" rx=".8"/>',
    alignright: '<path d="M13.5 2v12"/><rect x="3" y="3.6" width="8.6" height="3" rx=".8"/><rect x="6.4" y="9.4" width="5.2" height="3" rx=".8"/>',
    aligntop: '<path d="M2 2.5h12"/><rect x="3.6" y="4.4" width="3" height="8.6" rx=".8"/><rect x="9.4" y="4.4" width="3" height="5.2" rx=".8"/>',
    aligncv: '<path d="M2 8h12"/><rect x="3.6" y="3" width="3" height="10" rx=".8"/><rect x="9.4" y="5" width="3" height="6" rx=".8"/>',
    alignbottom: '<path d="M2 13.5h12"/><rect x="3.6" y="3" width="3" height="8.6" rx=".8"/><rect x="9.4" y="6.4" width="3" height="5.2" rx=".8"/>',
    disth: '<path d="M2.4 2v12M13.6 2v12"/><rect x="5.8" y="4.6" width="4.4" height="6.8" rx=".8"/>',
    distv: '<path d="M2 2.4h12M2 13.6h12"/><rect x="4.6" y="5.8" width="6.8" height="4.4" rx=".8"/>',
    data: '<ellipse cx="8" cy="3.8" rx="5.4" ry="2"/><path d="M2.6 3.8v8.4c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2V3.8M2.6 8c0 1.1 2.4 2 5.4 2s5.4-.9 5.4-2"/>',
    check: '<path d="m3 8.6 3.2 3.2L13 5"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    chevdown: '<path d="m4 6 4 4 4-4"/>',
    chevleft: '<path d="m10 4-4 4 4 4"/>',
    chevright: '<path d="m6 4 4 4-4 4"/>',
    drag: '<circle cx="6" cy="3.6" r="1"/><circle cx="10" cy="3.6" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12.4" r="1"/><circle cx="10" cy="12.4" r="1"/>',
    token: '<path d="M6 3.2C4.6 3.2 4.4 4 4.4 5v1.4c0 .9-.6 1.6-1.6 1.6 1 0 1.6.7 1.6 1.6V11c0 1 .2 1.8 1.6 1.8M10 3.2c1.4 0 1.6.8 1.6 1.8v1.4c0 .9.6 1.6 1.6 1.6-1 0-1.6.7-1.6 1.6V11c0 1-.2 1.8-1.6 1.8"/>',
    bold: '<path d="M5 2.8h4a2.4 2.4 0 0 1 0 4.8H5zM5 7.6h4.6a2.6 2.6 0 0 1 0 5.2H5z" stroke-width="1.7"/>',
    italic: '<path d="M6.5 2.8h5M4.5 13.2h5M9 2.8l-2 10.4"/>',
    underline: '<path d="M4.4 2.6v5a3.6 3.6 0 0 0 7.2 0v-5M3.6 13.4h8.8"/>',
    print: '<path d="M4 6V2.5h8V6M4 11H2.5V6.5h11V11H12M4 9.5h8v4H4z"/>',
    spellcheck: '<path d="M2.5 12.5 5 3l2.5 9.5M3.4 9h3.2M9 10.5l1.8 1.8 3-4"/>',
    paint: '<path d="M2 3h8v4H2zM10 4h2.5v3H8M6 7v2.5M5 9.5h2v4H5z"/>',
    color: '<path d="M4 12.5 8 2.8l4 9.7M5.2 9.5h5.6"/><path d="M3 14h10" stroke-width="2.4"/>',
    corners: '<path d="M3 13V7a4 4 0 0 1 4-4h6"/><circle cx="12.5" cy="3" r="1" fill="currentColor" stroke="none"/>',
    stroke: '<path d="M2.5 4h11" stroke-width=".8"/><path d="M2.5 8h11" stroke-width="1.7"/><path d="M2.5 12h11" stroke-width="2.8"/>',
    highlight: '<path d="m5 10.8-2-2L9.8 2l2 2zM2.5 13.5h7"/><path d="m10.8 3 2.2 2.2" stroke-width="2.5"/>',
    link: '<path d="M6.2 10.2 5 11.4a2.4 2.4 0 0 1-3.4-3.4l2.2-2.2a2.4 2.4 0 0 1 3.4 0M9.8 5.8 11 4.6A2.4 2.4 0 0 1 14.4 8l-2.2 2.2a2.4 2.4 0 0 1-3.4 0M5.5 8h5"/>',
    comment: '<path d="M2.5 3h11v8H7l-3.2 2.5V11H2.5zM8 5v4M6 7h4"/>',
    linespacing: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 3v10M1 4.5 2.5 3 4 4.5M1 11.5 2.5 13 4 11.5"/>',
    numbered: '<path d="M6 4h7M6 8h7M6 12h7M2 3h1v2M2 8c0-1 2-1 2 0 0 .8-2 1.2-2 2h2M2 12h2l-2 2h2"/>',
    indent: '<path d="M2 3h12M6 7h8M6 11h8M2 6l3 2-3 2"/>',
    outdent: '<path d="M2 3h12M6 7h8M6 11h8M5 6 2 8l3 2"/>',
    clearformat: '<path d="m3 12 7.5-9 2.5 2-7.5 9H3zM8.5 13.5H14M7.5 6l3 2.5"/>',
    more: '<circle cx="3.2" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="12.8" cy="8" r=".9" fill="currentColor" stroke="none"/>',
    microphone: '<path d="M8 10.2a2.7 2.7 0 0 0 2.7-2.7V4.7a2.7 2.7 0 1 0-5.4 0v2.8A2.7 2.7 0 0 0 8 10.2z"/><path d="M3.7 7.4a4.3 4.3 0 0 0 8.6 0M8 11.7V14M5.7 14h4.6"/>',
    pencil: '<path d="m9.6 3.2 3.2 3.2-7.4 7.4-3.6.4.4-3.6zM8.4 4.4l3.2 3.2"/>',
    list: '<path d="M5.6 4h8M5.6 8h8M5.6 12h8"/><circle cx="2.7" cy="4" r="1"/><circle cx="2.7" cy="8" r="1"/><circle cx="2.7" cy="12" r="1"/>',
    pagebreak: '<path d="M3 2h10v4H3zM3 10h10v4H3z"/><path d="M2 8h2.5M6.5 8H9M11.5 8H14" stroke-dasharray="0"/>',
    table: '<rect x="2" y="2.6" width="12" height="10.8" rx="1"/><path d="M2 6.2h12M6.6 6.2v7.2M11 6.2v7.2"/>',
    checkbox: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2"/><path d="m5.4 8.2 2 2 3.4-4"/>',
    margins: '<rect x="2" y="2" width="12" height="12" rx="1.2"/><rect x="4.6" y="4.6" width="6.8" height="6.8" rx="0.6" stroke-dasharray="2 1.6"/>',
    component: '<rect x="5.6" y="1.8" width="4.8" height="4.8" rx="1" transform="rotate(45 8 4.2)"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    bookmark: '<path d="M4.2 2.4h7.6v11.2L8 10.8l-3.8 2.8z"/>'
  };

  function iconSvg(name) {
    if (/^fa-[a-z0-9-]+$/i.test(String(name || ""))) return '<i class="fas ' + esc(name) + '" aria-hidden="true"></i>';
    const body = ICONS[name];
    return body ? SVG_OPEN + body + "</svg>" : "";
  }

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function debounce(fn, wait) {
    let timer = null;
    const wrapped = function () {
      const args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(null, args);
      }, wait);
    };
    wrapped.flush = function () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        fn();
      }
    };
    wrapped.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return wrapped;
  }

  function num(value, fallback) {
    const parsed = typeof value === "number" ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function roundPt(value) {
    return Math.round(value * 100) / 100;
  }

  function isObj(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function parseCssColor(value) {
    const text = String(value || "").trim();
    let match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (match) {
      let hex = match[1];
      if (hex.length === 3) hex = hex.split("").map(function (ch) { return ch + ch; }).join("");
      return {
        css: "#" + hex.toLowerCase(),
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }
    match = text.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,\/]\s*[\d.]+)?\s*\)$/i);
    if (!match) return null;
    const rgb = [match[1], match[2], match[3]].map(function (part) { return clamp(Math.round(Number(part)), 0, 255); });
    return { css: "rgb(" + rgb.join(", ") + ")", r: rgb[0], g: rgb[1], b: rgb[2] };
  }

  function colorLuminance(color) {
    const channels = [color.r, color.g, color.b].map(function (channel) {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(a, b) {
    const lighter = Math.max(colorLuminance(a), colorLuminance(b));
    const darker = Math.min(colorLuminance(a), colorLuminance(b));
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** DOM element builder. attrs: class, style, text, html, data-attrs, on-handlers. */
  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key === "html") node.innerHTML = value;
        else if (key === "text") node.textContent = value;
        else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (let i = 2; i < arguments.length; i += 1) appendChild(node, arguments[i]);
    return node;
  }

  function appendChild(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      for (const item of child) appendChild(parent, item);
      return;
    }
    if (typeof child === "string") parent.appendChild(document.createTextNode(child));
    else parent.appendChild(child);
  }

  function iconBtn(name, title, onClick, extraClass) {
    return el("button", {
      type: "button",
      class: "fmde-btn" + (extraClass ? " " + extraClass : ""),
      title: title || "",
      "aria-label": title || name,
      html: iconSvg(name),
      onclick: onClick
    });
  }

  function widgetRefParts(ref) {
    const str = String(ref || "");
    const at = str.lastIndexOf("@");
    return {
      id: at === -1 ? str : str.slice(0, at),
      version: at === -1 ? 1 : Number(str.slice(at + 1)) || 1
    };
  }

  // ---------------------------------------------------------------------------
  // Command engine (DOM-free — exported for tests as _createCommandEngine)
  //
  // Every mutation flows through apply(). Each history entry stores the
  // executed commands plus their inverse commands (already reversed), so undo
  // replays inverses and redo replays the originals. Edit policy + per-node
  // locks are enforced here — the single enforcement point of contract §9.3.
  // ---------------------------------------------------------------------------

  function createCommandEngine(ctx) {
    const M = ctx.M;
    const undoStack = [];
    const redoStack = [];

    function doc() {
      return ctx.getDoc();
    }

    function flags() {
      return ctx.getFlags() || {};
    }

    function profile() {
      return ctx.getProfile() || "designer";
    }

    function canFeature(key) {
      const value = flags()[key];
      if (Array.isArray(value)) return value.length > 0;
      return !!value;
    }

    function widgetAllowed(widgetId) {
      const value = flags().widget_insert;
      if (value === true) return true;
      if (Array.isArray(value)) return value.indexOf(widgetId) !== -1;
      return false;
    }

    function lockBlocked(node, key) {
      const value = node && node.locks ? node.locks[key] : undefined;
      if (value === true) return true;
      if (typeof value === "string" && value.indexOf("role:") === 0) {
        const required = value.slice(5);
        return (PROFILE_RANK[profile()] || 0) < (PROFILE_RANK[required] !== undefined ? PROFILE_RANK[required] : 99);
      }
      return false;
    }

    function reject(reason) {
      return { ok: false, reason };
    }

    /**
     * Requirements to mutate a node prop path. Returns null when allowed,
     * else a reason string.
     */
    function checkNodeSet(node, prop, value) {
      const path = String(prop);
      const frame = node.frame || {};
      const needs = [];
      const frameComponent = function (key, next) {
        if (key === "x" || key === "y") needs.push({ feature: "free_transform", lock: "move" });
        else if (key === "w" || key === "h") needs.push({ feature: "resize", lock: "resize" });
        else if (key === "rotation") needs.push({ feature: "rotate", lock: "rotate" });
        else if (key === "z") needs.push({ feature: "z_order" });
        else if (key === "layout" || key === "constraints") needs.push({ lock: "move" });
      };
      if (path === "frame" && isObj(value)) {
        for (const key of Object.keys(value)) {
          const prev = frame[key];
          const nextVal = value[key];
          const same = typeof prev === "number" && typeof nextVal === "number" ? Math.abs(prev - nextVal) < 0.001 : JSON.stringify(prev) === JSON.stringify(nextVal);
          if (!same) frameComponent(key, nextVal);
        }
      } else if (path.indexOf("frame.") === 0) {
        frameComponent(path.split(".")[1]);
      } else if (path === "style" || path.indexOf("style.") === 0) {
        needs.push({ lock: "style" });
        if (path.indexOf("style.filters") === 0) needs.push({ feature: "filters" });
        if (path.indexOf("style.font") === 0) needs.push({ feature: "text_style" });
      } else if (path === "bind" || path.indexOf("bind.") === 0) {
        needs.push({ feature: "bind_edit" });
      } else if (path.indexOf("props.") === 0 || path === "props") {
        if (node.type === "text") {
          needs.push({ lock: "content" });
          if (path.indexOf("props.blocks") !== 0) needs.push({ feature: "text_style" });
        } else if (node.type === "widget") {
          needs.push({ lock: "content" });
        } else if (node.type === "image") {
          needs.push({ lock: "content", feature: "images" });
        } else {
          needs.push({ lock: "content" });
        }
      }
      // visible / locks / name are rail affordances — no feature gate.
      for (const need of needs) {
        if (need.feature && !canFeature(need.feature)) return "feature_disabled:" + need.feature;
        if (need.lock && lockBlocked(node, need.lock)) return "locked:" + need.lock;
      }
      return null;
    }

    function policyCheck(cmd) {
      const d = doc();
      // Fill profile: only text content edits pass the bus (widget inputs go
      // through the renderer's interactive widgets, not commands).
      if (profile() === "fill" && cmd.type !== "text.edit" && cmd.type !== "header_footer.sync") return reject("profile_readonly");
      switch (cmd.type) {
        case "node.set": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const reason = checkNodeSet(found.node, cmd.prop, cmd.value);
          return reason ? reject(reason) : { ok: true };
        }
        case "node.insert": {
          const node = cmd.node || {};
          if (node.type === "shape" && !canFeature("shapes")) {
            // A flow-anchored hairline rule (Insert ▸ Horizontal line) is body
            // copy like any paragraph, not a drawing — writers may insert it
            // even where the shapes tool itself is designer-gated.
            const frame = node.frame || {};
            const isFlowRule = node.anchor === "flow" && (Number(frame.h) || 0) <= 2;
            if (!isFlowRule || !canFeature("text_style")) return reject("feature_disabled:shapes");
          }
          if (node.type === "image" && !canFeature("images")) return reject("feature_disabled:images");
          if (node.type === "widget") {
            const ref = widgetRefParts(node.props && node.props.widget);
            if (!widgetAllowed(ref.id)) return reject("feature_disabled:widget_insert");
          }
          if (cmd.parent_id) {
            const parent = M.findNode(d, cmd.parent_id);
            if (!parent) return reject("parent_not_found");
            if (lockBlocked(parent.node, "children")) return reject("locked:children");
          }
          return { ok: true };
        }
        case "node.remove": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (lockBlocked(found.node, "delete")) return reject("locked:delete");
          return { ok: true };
        }
        case "node.move": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (lockBlocked(found.node, "move")) return reject("locked:move");
          if (!canFeature("free_transform")) return reject("feature_disabled:free_transform");
          return { ok: true };
        }
        case "node.reorder": {
          if (!canFeature("z_order")) return reject("feature_disabled:z_order");
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          return { ok: true };
        }
        case "node.group": {
          if (!canFeature("group")) return reject("feature_disabled:group");
          const ids = cmd.node_ids || [];
          if (ids.length < 1) return reject("nothing_to_group");
          for (const id of ids) {
            const found = M.findNode(d, id);
            if (!found) return reject("node_not_found");
            if (lockBlocked(found.node, "move")) return reject("locked:move");
          }
          return { ok: true };
        }
        case "node.ungroup": {
          if (!canFeature("group")) return reject("feature_disabled:group");
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (found.node.type !== "frame" || !Array.isArray(found.node.children) || !found.node.children.length) return reject("not_a_group");
          if (lockBlocked(found.node, "children")) return reject("locked:children");
          return { ok: true };
        }
        case "page.insert":
        case "page.move":
        case "page.set":
        case "theme.apply":
          if (!canFeature("page_manage")) return reject("feature_disabled:page_manage");
          return { ok: true };
        case "page.remove": {
          if (!canFeature("page_manage")) return reject("feature_disabled:page_manage");
          if ((d.pages || []).length <= 1) return reject("last_page");
          return { ok: true };
        }
        case "doc.set": {
          const prop = String(cmd.prop || "");
          if (prop === "theme_ref" || prop.indexOf("theme_ref.") === 0) {
            if (!canFeature("theme_edit")) return reject("feature_disabled:theme_edit");
          }
          return { ok: true };
        }
        case "text.edit": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (found.node.type !== "text") return reject("not_a_text_node");
          if (lockBlocked(found.node, "content")) return reject("locked:content");
          return { ok: true };
        }
        case "text.set_style_ref":
        case "text.split_block":
        case "text.merge_blocks": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (found.node.type !== "text") return reject("not_a_text_node");
          if (lockBlocked(found.node, "content")) return reject("locked:content");
          if (cmd.type === "text.set_style_ref") {
            if (lockBlocked(found.node, "style")) return reject("locked:style");
            if (!canFeature("text_style")) return reject("feature_disabled:text_style");
          }
          return { ok: true };
        }
        case "chain.set_defaults": {
          if (!cmd.chain_id) return reject("chain_id_required");
          if (!canFeature("page_manage")) return reject("feature_disabled:page_manage");
          return { ok: true };
        }
        case "node.set_anchor": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (lockBlocked(found.node, "move")) return reject("locked:move");
          return { ok: true };
        }
        case "component.update_def": {
          if (!cmd.name) return reject("component_name_required");
          return { ok: true };
        }
        case "component.detach": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (found.node.type !== "component_ref") return reject("not_a_component_ref");
          if (lockBlocked(found.node, "content")) return reject("locked:content");
          return { ok: true };
        }
        case "header_footer.sync": {
          const source = M.findNode(d, cmd.source_region_id);
          const region = source && source.node && source.node.props && String(source.node.props.page_region || "");
          if (!source || source.node.type !== "frame" || !/^(header|footer)(?:_(first|even))?$/.test(region)) return reject("header_footer_region_not_found");
          return { ok: true };
        }
        default:
          return reject("unknown_command:" + cmd.type);
      }
    }

    // -- execution ------------------------------------------------------------

    function nodeLocation(found) {
      return {
        parent_id: found.parent ? found.parent.id : null,
        page_id: found.page ? found.page.id : null,
        index: found.index
      };
    }

    function siblingList(d, found) {
      if (found.parent) return found.parent.children;
      if (found.page) return found.page.children;
      if (d.kind === "view" && d.root) return d.root.children;
      return null;
    }

    function commandParentWidthPt(d, loc) {
      if (loc && loc.parent_id) {
        const parent = M.findNode(d, loc.parent_id);
        const width = parent && parent.node && parent.node.frame && Number(parent.node.frame.w);
        if (Number.isFinite(width) && width > 0) return width;
      }
      if (d.kind === "view" && d.root && d.root.frame) {
        const rootWidth = Number(d.root.frame.w);
        if (Number.isFinite(rootWidth) && rootWidth > 0) return rootWidth;
      }
      const paper = M.paperDimensions(d);
      return Number(paper && paper.w_pt) || 720;
    }

    function responsiveFrameInParent(frame, parentWidthPt, basis) {
      if (!frame || typeof M.horizontalPositionFromLeft !== "function") return frame;
      const width = Number(frame.w) || 0;
      const parentWidth = Number(parentWidthPt) || 0;
      if (!(parentWidth > 0)) return frame;
      frame.position = frame.position && typeof frame.position === "object" ? frame.position : {};
      frame.position.x = M.horizontalPositionFromLeft(
        (Number(frame.x) || 0) * PX_PER_PT,
        width * PX_PER_PT,
        parentWidth * PX_PER_PT,
        basis || frame.position.x || { unit: "percent", anchor: "center", value: 0 }
      );
      return frame;
    }

    function headerFooterRegionFrame(d, nodeId) {
      let found = nodeId ? M.findNode(d, nodeId) : null;
      let hops = 0;
      while (found && hops < 64) {
        const region = found.node && found.node.props && String(found.node.props.page_region || "");
        if (found.node.type === "frame" && /^(header|footer)(?:_(first|even))?$/.test(region)) return found.node;
        found = found.parent ? M.findNode(d, found.parent.id) : null;
        hops += 1;
      }
      return null;
    }

    function commandsWithHeaderFooterSync(commands) {
      const incoming = Array.isArray(commands) ? commands.slice() : [commands];
      const regionIds = new Set();
      const explicitSyncIds = new Set();
      const d = doc();
      const findRegion = function (nodes, region) {
        let hit = null;
        (function visit(list) {
          for (const node of list || []) {
            if (hit) return;
            if (node && node.type === "frame" && node.props && String(node.props.page_region || "") === region) { hit = node; return; }
            visit(node && node.children);
          }
        })(nodes);
        return hit;
      };
      const sourceRegion = function (region) {
        for (const page of d.pages || []) {
          const hit = findRegion(page.children, region);
          if (hit) return hit;
        }
        return null;
      };
      const list = incoming.map(function (cmd) {
        if (!cmd || cmd.type !== "page.insert" || !cmd.page) return cmd;
        const page = M.deepClone(cmd.page);
        if (!Array.isArray(page.children)) page.children = [];
        const options = d.settings && d.settings.header_options || {};
        const suffixes = [];
        if (options.different_first) suffixes.push("first");
        if (options.different_odd_even) suffixes.push("even");
        for (const suffix of suffixes) {
          for (const kind of ["header", "footer"]) {
            const region = kind + "_" + suffix;
            if (findRegion(page.children, region)) continue;
            const source = sourceRegion(region);
            if (!source) continue;
            const frame = M.deepClone(source);
            frame.id = M.generateId("nd");
            if (frame.props) delete frame.props.chain;
            frame.children = syncedRegionChildren(source.children, []);
            page.children.push(frame);
          }
        }
        return { ...cmd, page: page };
      });
      for (const cmd of list) {
        if (!cmd) continue;
        if (cmd.type === "header_footer.sync") { explicitSyncIds.add(cmd.source_region_id); continue; }
        const ids = [];
        if (cmd.node_id) ids.push(cmd.node_id);
        if (cmd.parent_id) ids.push(cmd.parent_id);
        for (const id of cmd.node_ids || []) ids.push(id);
        for (const id of ids) {
          const frame = headerFooterRegionFrame(d, id);
          if (frame) regionIds.add(frame.id);
        }
      }
      for (const sourceId of regionIds) {
        if (!explicitSyncIds.has(sourceId)) list.push({ type: "header_footer.sync", source_region_id: sourceId });
      }
      return list;
    }

    function syncedRegionChildren(sourceChildren, targetChildren) {
      const clones = M.deepClone(sourceChildren || []);
      const preserveIdentity = function (node, target) {
        const compatible = target && target.type === node.type;
        node.id = compatible && target.id ? target.id : M.generateId("nd");
        if (node.type === "text" && node.props && Array.isArray(node.props.blocks)) {
          const targetBlocks = compatible && target.props && Array.isArray(target.props.blocks) ? target.props.blocks : [];
          node.props.blocks.forEach(function (block, index) {
            block.id = targetBlocks[index] && targetBlocks[index].id ? targetBlocks[index].id : M.generateId("blk");
          });
        }
        (node.children || []).forEach(function (child, index) {
          preserveIdentity(child, compatible && target.children ? target.children[index] : null);
        });
      };
      clones.forEach(function (node, index) { preserveIdentity(node, (targetChildren || [])[index]); });
      return clones;
    }

    function execute(cmd) {
      const d = doc();
      switch (cmd.type) {
        case "node.set": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const prev = M.deepClone(M.getPath(found.node, cmd.prop));
          M.setPath(found.node, cmd.prop, M.deepClone(cmd.value));
          return { ok: true, inverse: [{ type: "node.set", node_id: cmd.node_id, prop: cmd.prop, value: prev }] };
        }
        case "node.insert": {
          const node = M.deepClone(cmd.node);
          if (!node.id) node.id = M.generateId("nd");
          const ok = M.insertNode(d, node, { parent_id: cmd.parent_id || null, page_id: cmd.page_id || null, index: cmd.index });
          if (!ok) return reject("target_not_found");
          return { ok: true, inverse: [{ type: "node.remove", node_id: node.id }], node_id: node.id };
        }
        case "node.remove": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const loc = nodeLocation(found);
          const removed = M.removeNode(d, cmd.node_id);
          if (!removed) return reject("node_not_found");
          return { ok: true, inverse: [{ type: "node.insert", node: removed, parent_id: loc.parent_id, page_id: loc.page_id, index: loc.index }] };
        }
        case "node.move": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const loc = nodeLocation(found);
          const prevFrame = M.deepClone(found.node.frame);
          const removed = M.removeNode(d, cmd.node_id);
          if (!removed) return reject("node_not_found");
          if (cmd.frame) removed.frame = M.deepMerge(removed.frame, cmd.frame);
          const ok = M.insertNode(d, removed, { parent_id: cmd.parent_id || null, page_id: cmd.page_id || null, index: cmd.index });
          if (!ok) {
            M.insertNode(d, removed, loc); // restore
            return reject("target_not_found");
          }
          return { ok: true, inverse: [{ type: "node.move", node_id: cmd.node_id, parent_id: loc.parent_id, page_id: loc.page_id, index: loc.index, frame: prevFrame }] };
        }
        case "node.reorder": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const list = siblingList(d, found);
          if (!list || list.length < 2) return { ok: true, inverse: [] };
          const order = list.slice().sort(function (a, b) {
            const za = (a.frame && a.frame.z) || 0;
            const zb = (b.frame && b.frame.z) || 0;
            if (za !== zb) return za - zb;
            return list.indexOf(a) - list.indexOf(b);
          });
          const pos = order.findIndex(function (n) { return n.id === cmd.node_id; });
          let target = pos;
          if (cmd.mode === "front") target = order.length - 1;
          else if (cmd.mode === "back") target = 0;
          else if (cmd.mode === "forward") target = Math.min(order.length - 1, pos + 1);
          else if (cmd.mode === "backward") target = Math.max(0, pos - 1);
          else if (typeof cmd.to === "number") target = clamp(cmd.to, 0, order.length - 1);
          const moved = order.splice(pos, 1)[0];
          order.splice(target, 0, moved);
          const inverse = [];
          for (let i = 0; i < order.length; i += 1) {
            const node = order[i];
            const prevZ = (node.frame && node.frame.z) || 0;
            if (prevZ !== i) {
              if (!node.frame) node.frame = {};
              node.frame.z = i;
              inverse.push({ type: "node.set", node_id: node.id, prop: "frame.z", value: prevZ });
            }
          }
          return { ok: true, inverse: inverse };
        }
        case "node.group": {
          const ids = cmd.node_ids || [];
          const memberFrames = cmd.member_frames && typeof cmd.member_frames === "object" ? cmd.member_frames : {};
          const frameFor = function (entry) {
            const override = memberFrames[entry.node.id];
            return override ? M.deepMerge(entry.node.frame || {}, override) : M.deepClone(entry.node.frame || {});
          };
          const entries = [];
          for (const id of ids) {
            const found = M.findNode(d, id);
            if (!found) return reject("node_not_found");
            entries.push(found);
          }
          const first = entries[0];
          const loc = nodeLocation(first);
          for (const entry of entries) {
            const eloc = nodeLocation(entry);
            if (eloc.parent_id !== loc.parent_id || eloc.page_id !== loc.page_id) return reject("nodes_not_siblings");
          }
          let group;
          let base;
          if (cmd.group) {
            group = M.deepClone(cmd.group);
            group.props = Object.assign({}, group.props, { fmde_group: true });
            group.children = [];
            base = group.frame;
          } else {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
            for (const entry of entries) {
              const sourceFrame = frameFor(entry);
              const b = M.frameBounds(sourceFrame);
              minX = Math.min(minX, b.x);
              minY = Math.min(minY, b.y);
              maxX = Math.max(maxX, b.x + b.w);
              maxY = Math.max(maxY, b.y + b.h);
              maxZ = Math.max(maxZ, sourceFrame.z || 0);
            }
            group = M.createNode("frame", {
              name: "Group",
              anchor: entries.every(function (entry) { return entry.node.anchor === "page"; }) ? "page" : undefined,
              frame: { x: roundPt(minX), y: roundPt(minY), w: roundPt(maxX - minX), h: roundPt(maxY - minY), rotation: 0, z: maxZ, layout: "absolute" },
              props: { fmde_group: true }
            });
            group.children = [];
            base = group.frame;
          }
          const layoutBase = cmd.layout_frame ? M.deepMerge(base || {}, cmd.layout_frame) : M.deepClone(base || {});
          if (d.kind === "view" && (!cmd.group || !(group.frame && group.frame.position && group.frame.position.x))) {
            const parentWidth = Number(cmd.parent_width_pt) || commandParentWidthPt(d, loc);
            responsiveFrameInParent(group.frame, parentWidth, { unit: "percent", anchor: "center", value: 0 });
          }
          const insertIndex = Math.min.apply(null, entries.map(function (entry) { return entry.index; }));
          // Detach members (z-order preserved inside the group).
          const ordered = entries.slice().sort(function (a, b) {
            return (((a.node.frame && a.node.frame.z) || 0) - ((b.node.frame && b.node.frame.z) || 0)) || (a.index - b.index);
          });
          const grot = (layoutBase && layoutBase.rotation) || 0;
          const gcx = layoutBase.x + (layoutBase.w || 0) / 2;
          const gcy = layoutBase.y + (layoutBase.h || 0) / 2;
          for (const entry of ordered) {
            const node = M.removeNode(d, entry.node.id);
            if (!node) return reject("node_not_found");
            const previousPosition = node.frame && node.frame.position && node.frame.position.x;
            node.frame = frameFor(entry);
            const f = node.frame;
            const w = f.w || 0;
            const h = f.h || 0;
            let cx = f.x + w / 2;
            let cy = f.y + h / 2;
            if (grot) {
              // Inverse of the ungroup transform: pull the child back into
              // group-local space, removing the group's rotation.
              const local = M.rotatePoint(cx, cy, gcx, gcy, -grot);
              cx = local.x;
              cy = local.y;
              f.rotation = (f.rotation || 0) - grot;
            }
            f.x = roundPt(cx - w / 2 - layoutBase.x);
            f.y = roundPt(cy - h / 2 - layoutBase.y);
            if (d.kind === "view") responsiveFrameInParent(f, layoutBase.w, previousPosition);
            group.children.push(node);
          }
          const ok = M.insertNode(d, group, { parent_id: loc.parent_id, page_id: loc.page_id, index: insertIndex });
          if (!ok) return reject("target_not_found");
          return {
            ok: true,
            inverse: [{
              type: "node.ungroup", node_id: group.id,
              parent_width_pt: cmd.parent_width_pt,
              group_frame: M.deepClone(layoutBase)
            }],
            node_id: group.id
          };
        }
        case "node.ungroup": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const group = found.node;
          if (group.type !== "frame" || !Array.isArray(group.children) || !group.children.length) return reject("not_a_group");
          const loc = nodeLocation(found);
          const groupClone = M.deepClone(group);
          groupClone.children = [];
          const childIds = group.children.map(function (child) { return child.id; });
          const gf = cmd.group_frame ? M.deepMerge(group.frame || {}, cmd.group_frame) : (group.frame || {});
          const memberFrames = cmd.member_frames && typeof cmd.member_frames === "object" ? cmd.member_frames : {};
          const grot = gf.rotation || 0;
          const gcx = gf.x + (gf.w || 0) / 2;
          const gcy = gf.y + (gf.h || 0) / 2;
          const children = group.children.slice();
          M.removeNode(d, group.id);
          let index = loc.index;
          for (const child of children) {
            const previousPosition = child.frame && child.frame.position && child.frame.position.x;
            if (memberFrames[child.id]) child.frame = M.deepMerge(child.frame || {}, memberFrames[child.id]);
            const f = child.frame || {};
            const w = f.w || 0;
            const h = f.h || 0;
            let cx = gf.x + f.x + w / 2;
            let cy = gf.y + f.y + h / 2;
            if (grot) {
              const abs = M.rotatePoint(cx, cy, gcx, gcy, grot);
              cx = abs.x;
              cy = abs.y;
              f.rotation = (f.rotation || 0) + grot;
            }
            f.x = roundPt(cx - w / 2);
            f.y = roundPt(cy - h / 2);
            if (d.kind === "view") responsiveFrameInParent(f, Number(cmd.parent_width_pt) || commandParentWidthPt(d, loc), previousPosition);
            const ok = M.insertNode(d, child, { parent_id: loc.parent_id, page_id: loc.page_id, index: index });
            if (!ok) return reject("target_not_found");
            index += 1;
          }
          return {
            ok: true,
            inverse: [{
              type: "node.group", node_ids: childIds, group: groupClone,
              layout_frame: M.deepClone(gf), parent_width_pt: cmd.parent_width_pt
            }]
          };
        }
        case "page.insert": {
          if (d.kind !== "document") return reject("not_a_paged_document");
          const page = M.deepClone(cmd.page);
          if (!page.id) page.id = M.generateId("pg");
          const index = typeof cmd.index === "number" ? clamp(cmd.index, 0, d.pages.length) : d.pages.length;
          d.pages.splice(index, 0, page);
          return { ok: true, inverse: [{ type: "page.remove", page_id: page.id }], page_id: page.id };
        }
        case "page.remove": {
          const found = M.findPage(d, cmd.page_id);
          if (!found) return reject("page_not_found");
          d.pages.splice(found.index, 1);
          return { ok: true, inverse: [{ type: "page.insert", page: found.page, index: found.index }] };
        }
        case "page.move": {
          const found = M.findPage(d, cmd.page_id);
          if (!found) return reject("page_not_found");
          const prevIndex = found.index;
          const page = d.pages.splice(prevIndex, 1)[0];
          const index = clamp(typeof cmd.index === "number" ? cmd.index : d.pages.length, 0, d.pages.length);
          d.pages.splice(index, 0, page);
          return { ok: true, inverse: [{ type: "page.move", page_id: cmd.page_id, index: prevIndex }] };
        }
        case "page.set": {
          const found = M.findPage(d, cmd.page_id);
          if (!found) return reject("page_not_found");
          const prev = M.deepClone(M.getPath(found.page, cmd.prop));
          M.setPath(found.page, cmd.prop, M.deepClone(cmd.value));
          return { ok: true, inverse: [{ type: "page.set", page_id: cmd.page_id, prop: cmd.prop, value: prev }] };
        }
        case "doc.set": {
          const prev = M.deepClone(M.getPath(d, cmd.prop));
          M.setPath(d, cmd.prop, M.deepClone(cmd.value));
          return { ok: true, inverse: [{ type: "doc.set", prop: cmd.prop, value: prev }] };
        }
        case "theme.apply": {
          const prev = M.deepClone(d.theme_ref || null);
          d.theme_ref = cmd.theme_ref ? M.deepClone(cmd.theme_ref) : null;
          return { ok: true, inverse: [{ type: "theme.apply", theme_ref: prev }] };
        }
        case "text.edit": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (found.node.type !== "text") return reject("not_a_text_node");
          if (!found.node.props) found.node.props = {};
          const prev = M.deepClone(found.node.props.blocks || []);
          found.node.props.blocks = M.deepClone(cmd.blocks || []);
          return { ok: true, inverse: [{ type: "text.edit", node_id: cmd.node_id, blocks: prev }] };
        }
        case "text.set_style_ref": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const blocks = (found.node.props && found.node.props.blocks) || [];
          const idx = Number(cmd.block_index);
          if (!Number.isFinite(idx) || !blocks[idx]) return reject("block_not_found");
          const prevRef = blocks[idx].style_ref !== undefined ? blocks[idx].style_ref : null;
          if (cmd.ref) blocks[idx].style_ref = String(cmd.ref);
          else delete blocks[idx].style_ref;
          return { ok: true, inverse: [{ type: "text.set_style_ref", node_id: cmd.node_id, block_index: idx, ref: prevRef }] };
        }
        case "text.split_block": {
          // Split blocks[block_index] at a character offset measured across the
          // block's combined run text. The tail becomes a new block inheriting
          // type/align/style_ref/level. Inverse is an exact snapshot.
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (!found.node.props) found.node.props = {};
          const blocks = found.node.props.blocks || (found.node.props.blocks = []);
          const idx = Number(cmd.block_index);
          if (!Number.isFinite(idx) || !blocks[idx]) return reject("block_not_found");
          const prevBlocks = M.deepClone(blocks);
          const block = blocks[idx];
          const offset = Math.max(0, Number(cmd.offset) || 0);
          const headRuns = [];
          const tailRuns = [];
          let seen = 0;
          for (const run of block.runs || []) {
            const text = String(run.text || "");
            if (seen + text.length <= offset) headRuns.push(run);
            else if (seen >= offset) tailRuns.push(run);
            else {
              const cut = offset - seen;
              const head = M.deepClone(run);
              head.text = text.slice(0, cut);
              const tail = M.deepClone(run);
              tail.text = text.slice(cut);
              headRuns.push(head);
              tailRuns.push(tail);
            }
            seen += text.length;
          }
          block.runs = headRuns.length ? headRuns : [{ text: "" }];
          const tailBlock = {
            id: cmd.new_block_id || M.generateId("blk"),
            type: block.type || "paragraph",
            runs: tailRuns.length ? tailRuns : [{ text: "" }]
          };
          if (block.align) tailBlock.align = block.align;
          if (block.style_ref) tailBlock.style_ref = block.style_ref;
          if (block.level) tailBlock.level = block.level;
          if (block.indent) tailBlock.indent = block.indent;
          if (block.list_style) tailBlock.list_style = block.list_style;
          if (block.line_height) tailBlock.line_height = block.line_height;
          blocks.splice(idx + 1, 0, tailBlock);
          return { ok: true, inverse: [{ type: "text.edit", node_id: cmd.node_id, blocks: prevBlocks }], block_id: tailBlock.id };
        }
        case "text.merge_blocks": {
          // Merge blocks[block_index] into blocks[block_index - 1].
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const blocks = (found.node.props && found.node.props.blocks) || [];
          const idx = Number(cmd.block_index);
          if (!Number.isFinite(idx) || idx < 1 || !blocks[idx]) return reject("block_not_found");
          const prevBlocks = M.deepClone(blocks);
          const target = blocks[idx - 1];
          const donor = blocks[idx];
          const keep = (target.runs || []).filter(function (run) { return String(run.text || "") !== ""; });
          const add = (donor.runs || []).filter(function (run) { return String(run.text || "") !== ""; });
          target.runs = keep.concat(add);
          if (!target.runs.length) target.runs = [{ text: "" }];
          blocks.splice(idx, 1);
          return { ok: true, inverse: [{ type: "text.edit", node_id: cmd.node_id, blocks: prevBlocks }] };
        }
        case "chain.set_defaults": {
          const chainId = String(cmd.chain_id || "");
          if (!chainId) return reject("chain_id_required");
          if (!d.chains) d.chains = {};
          const prev = d.chains[chainId] === undefined ? null : M.deepClone(d.chains[chainId]);
          d.chains[chainId] = M.deepMerge(d.chains[chainId] || {}, M.deepClone(cmd.defaults || {}));
          return { ok: true, inverse: [{ type: "doc.set", prop: "chains." + chainId, value: prev }] };
        }
        case "node.set_anchor": {
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          const prev = found.node.anchor === undefined ? null : M.deepClone(found.node.anchor);
          if (cmd.anchor === null || cmd.anchor === undefined) delete found.node.anchor;
          else found.node.anchor = M.deepClone(cmd.anchor);
          return { ok: true, inverse: [{ type: "node.set_anchor", node_id: cmd.node_id, anchor: prev }] };
        }
        case "component.update_def": {
          const name = String(cmd.name || "");
          if (!name) return reject("component_name_required");
          if (!d.components) d.components = {};
          const prev = d.components[name] === undefined ? null : M.deepClone(d.components[name]);
          if (cmd.def === null || cmd.def === undefined) delete d.components[name];
          else d.components[name] = M.deepClone(cmd.def);
          return { ok: true, inverse: [{ type: "component.update_def", name: name, def: prev }] };
        }
        case "component.detach": {
          // Fork: the ref keeps rendering its (frozen) resolved subtree and
          // stops following the definition. children supplied by the caller
          // (current resolved instance subtree).
          const found = M.findNode(d, cmd.node_id);
          if (!found) return reject("node_not_found");
          if (found.node.type !== "component_ref") return reject("not_a_component_ref");
          const node = found.node;
          const prevDetached = node.props && node.props.detached !== undefined ? node.props.detached : null;
          const prevChildren = node.children === undefined ? null : M.deepClone(node.children);
          if (!node.props) node.props = {};
          node.props.detached = true;
          node.children = M.deepClone(cmd.children || []);
          return {
            ok: true,
            inverse: [
              { type: "node.set", node_id: cmd.node_id, prop: "children", value: prevChildren },
              { type: "node.set", node_id: cmd.node_id, prop: "props.detached", value: prevDetached }
            ]
          };
        }
        case "header_footer.sync": {
          const source = M.findNode(d, cmd.source_region_id);
          const region = source && source.node && source.node.props && String(source.node.props.page_region || "");
          if (!source || source.node.type !== "frame" || !/^(header|footer)(?:_(first|even))?$/.test(region)) return reject("header_footer_region_not_found");
          const inverses = [];
          for (const page of d.pages || []) {
            let target = null;
            (function visit(nodes) {
              for (const node of nodes || []) {
                if (target) return;
                if (node && node.type === "frame" && node.props && String(node.props.page_region || "") === region) { target = node; return; }
                visit(node && node.children);
              }
            })(page.children);
            if (!target || target.id === source.node.id) continue;
            for (const prop of ["frame", "style", "visible", "locks", "children", "props"]) {
              inverses.push({ type: "node.set", node_id: target.id, prop: prop, value: M.deepClone(target[prop]) });
            }
            const targetChain = target.props && target.props.chain ? M.deepClone(target.props.chain) : null;
            const nextProps = M.deepClone(source.node.props || {});
            nextProps.page_region = region;
            if (targetChain) nextProps.chain = targetChain; else delete nextProps.chain;
            delete nextProps.fmde_doc_placeholder;
            delete nextProps.fmde_placeholder_page_id;
            target.frame = M.deepClone(source.node.frame);
            target.style = M.deepClone(source.node.style);
            target.visible = source.node.visible;
            target.locks = M.deepClone(source.node.locks);
            target.props = nextProps;
            target.children = syncedRegionChildren(source.node.children, target.children);
          }
          return { ok: true, inverse: inverses };
        }
        default:
          return reject("unknown_command:" + cmd.type);
      }
    }

    function rollback(inverses) {
      for (let i = inverses.length - 1; i >= 0; i -= 1) execute(inverses[i]);
    }

    /**
     * Apply a batch of commands as one atomic history entry. Policy-checked;
     * all-or-nothing (partial application is rolled back).
     */
    function apply(commands, meta) {
      const list = commandsWithHeaderFooterSync(commands);
      if (!list.length) return { ok: false, reason: "no_commands" };
      const applied = [];
      const inverses = [];
      const results = [];
      for (const cmd of list) {
        const policy = policyCheck(cmd);
        if (!policy.ok) {
          rollback(inverses);
          return { ok: false, reason: policy.reason, command: cmd };
        }
        const result = execute(cmd);
        if (!result.ok) {
          rollback(inverses);
          return { ok: false, reason: result.reason, command: cmd };
        }
        applied.push(cmd);
        results.push(result);
        for (const inv of result.inverse) inverses.push(inv);
      }
      const entry = {
        label: (meta && meta.label) || list[0].type,
        commands: applied,
        inverse: inverses.slice().reverse(),
        at: Date.now()
      };
      undoStack.push(entry);
      if (undoStack.length > HISTORY_CAP) undoStack.shift();
      redoStack.length = 0;
      if (ctx.onApplied) ctx.onApplied(entry, "apply", results);
      return { ok: true, results: results };
    }

    function undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      for (const cmd of entry.inverse) execute(cmd);
      redoStack.push(entry);
      if (ctx.onApplied) ctx.onApplied(entry, "undo");
      return true;
    }

    function redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      for (const cmd of entry.commands) execute(cmd);
      undoStack.push(entry);
      if (ctx.onApplied) ctx.onApplied(entry, "redo");
      return true;
    }

    return {
      apply: apply,
      undo: undo,
      redo: redo,
      canUndo: function () { return undoStack.length > 0; },
      canRedo: function () { return redoStack.length > 0; },
      clear: function () { undoStack.length = 0; redoStack.length = 0; },
      policyCheck: policyCheck,
      lockBlocked: lockBlocked,
      canFeature: canFeature,
      widgetAllowed: widgetAllowed,
      historySize: function () { return undoStack.length; }
    };
  }

  // ---------------------------------------------------------------------------
  // Styles — embedded and self-injected so the app runtime (which only loads
  // JS bundles) never needs a separate <link> for doc-editor.css. Keep in
  // sync with doc-editor.css (the standalone mirror for dev harnesses).
  // ---------------------------------------------------------------------------

  const EDITOR_STYLE_ELEMENT_ID = "fmde-editor-styles";
  const EDITOR_CSS_V2 = "\n/* ---------- v2: mode system ---------- */\n\n.fmde-modeseg {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  padding: 2px;\n  border-radius: 8px;\n  background: rgba(17, 24, 39, 0.07);\n}\n.fmde-modebtn {\n  height: 24px;\n  padding: 0 11px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--fmde-muted);\n  font: inherit;\n  font-size: 12px;\n  font-weight: 700;\n  cursor: pointer;\n}\n.fmde-modebtn:hover { color: var(--fmde-text); }\n.fmde-modebtn.active { background: #fff; color: var(--fmde-text); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.2); }\n.fmde-mode-doc .fmde-rail, .fmde-mode-doc .fmde-inspector,\n.fmde-mode-preview .fmde-rail, .fmde-mode-preview .fmde-inspector { display: none; }\n\n/* ---------- doc mode: contenteditable projection ---------- */\n\n.fmde-docedit { outline: none; cursor: text; caret-color: var(--fmde-accent); }\n.fmde-docedit:focus { outline: none; }\n.fmde-mode-doc .fmde-docedit .fmdoc-block { min-height: 1em; }\n.fmde-mode-doc [data-chain] { cursor: text; }\n\n/* page_break marker (visual + doc modes) */\n.fmde-mode-doc .fmdoc-page_break, .fmde-mode-visual .fmdoc-page_break { position: relative; overflow: visible !important; }\n.fmde-mode-doc .fmdoc-page_break::before, .fmde-mode-visual .fmdoc-page_break::before {\n  content: \"\";\n  position: absolute;\n  left: 0;\n  right: 0;\n  top: 0;\n  border-top: 1px dashed var(--fmde-accent);\n  opacity: 0.65;\n}\n.fmde-mode-doc .fmdoc-page_break::after, .fmde-mode-visual .fmdoc-page_break::after {\n  content: \"PAGE BREAK\";\n  position: absolute;\n  left: 50%;\n  top: 0;\n  transform: translate(-50%, -50%);\n  padding: 1px 7px;\n  border-radius: 999px;\n  background: var(--fmde-accent);\n  color: #fff;\n  font: 700 7px/1.7 Inter, sans-serif;\n  letter-spacing: 0.08em;\n  white-space: nowrap;\n}\n\n/* ---------- visual v2: chain chrome + component badges ---------- */\n\n.fmde-chaintint {\n  position: absolute;\n  pointer-events: none;\n  background: rgba(37, 99, 235, 0.035);\n  border: calc(1 * var(--fmde-px, 1px)) dashed rgba(37, 99, 235, 0.35);\n}\n.fmde-chainchip {\n  position: absolute;\n  pointer-events: none;\n  transform: translateY(-100%);\n  display: inline-flex;\n  align-items: center;\n  padding: calc(2 * var(--fmde-px, 1px)) calc(7 * var(--fmde-px, 1px));\n  border-radius: calc(5 * var(--fmde-px, 1px)) calc(5 * var(--fmde-px, 1px)) 0 0;\n  background: var(--fmde-accent);\n  color: #fff;\n  font-size: calc(8.5 * var(--fmde-px, 1px));\n  font-weight: 700;\n  letter-spacing: 0.04em;\n  white-space: nowrap;\n}\n.fmde-compbadge {\n  position: absolute;\n  left: calc(-1.5 * var(--fmde-px, 1px));\n  top: calc(-1.5 * var(--fmde-px, 1px));\n  transform: translateY(-100%);\n  padding: calc(2 * var(--fmde-px, 1px)) calc(7 * var(--fmde-px, 1px));\n  border-radius: calc(5 * var(--fmde-px, 1px)) calc(5 * var(--fmde-px, 1px)) 0 0;\n  background: #7c3aed;\n  color: #fff;\n  font-size: calc(8.5 * var(--fmde-px, 1px));\n  font-weight: 700;\n  white-space: nowrap;\n  pointer-events: none;\n}\n\n/* ---------- doc-mode toolbar bits ---------- */\n\n.fmde-styleselect { min-width: 132px; max-width: 168px; }\n\n/* ---------- component editing card ---------- */\n\n.fmde-compcard {\n  position: absolute;\n  right: 18px;\n  top: 14px;\n  z-index: 800;\n  width: 372px;\n  max-height: calc(100% - 28px);\n  display: flex;\n  flex-direction: column;\n  background: #fff;\n  border: 1px solid var(--fmde-border);\n  border-radius: 12px;\n  box-shadow: var(--fmde-shadow);\n  overflow: hidden;\n}\n.fmde-compcard-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex: 0 0 auto;\n  padding: 10px 12px;\n  border-bottom: 1px solid var(--fmde-border-soft);\n  font-weight: 800;\n}\n.fmde-compcard-head .fmde-btn { margin-left: auto; }\n.fmde-compcard-preview {\n  flex: 0 0 auto;\n  max-height: 220px;\n  overflow: auto;\n  padding: 10px 12px;\n  background: #f8fafc;\n  border-bottom: 1px solid var(--fmde-border-soft);\n}\n.fmde-compcard-preview .fmdoc-page { box-shadow: none; border: 1px solid var(--fmde-border-soft); }\n.fmde-compcard-body {\n  flex: 1 1 auto;\n  overflow-y: auto;\n  padding: 10px 12px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.fmde-compcard-note { font-size: 11.5px; color: var(--fmde-muted); }\n";
  const EDITOR_CSS = "/* FirstMate Doc Editor chrome (doc-editor.css)\n * Companion stylesheet for firstmate-doc-editor.js. All classes fmde-*.\n * Visual language follows customer_portal: neutral grays, subtle borders,\n * primary accent from --fm-primary (fallback #2563EB).\n */\n\n.fmde-root {\n  --fmde-accent: var(--fm-primary, #2563eb);\n  --fmde-accent-soft: rgba(37, 99, 235, 0.12);\n  --fmde-on-accent: #ffffff;\n  --fmde-bg: #f4f6f8;\n  --fmde-panel: #ffffff;\n  --fmde-border: rgba(17, 24, 39, 0.12);\n  --fmde-border-soft: rgba(17, 24, 39, 0.07);\n  --fmde-text: #111827;\n  --fmde-muted: #6b7280;\n  --fmde-guide: #f43f5e;\n  --fmde-radius: 8px;\n  --fmde-shadow: 0 10px 30px rgba(15, 23, 42, 0.14);\n\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  width: 100%;\n  height: 100%;\n  min-height: 420px;\n  background: var(--fmde-bg);\n  color: var(--fmde-text);\n  font-family: Inter, ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif;\n  font-size: 13px;\n  outline: none;\n  overflow: hidden;\n}\n.fmde-root *, .fmde-root *::before, .fmde-root *::after { box-sizing: border-box; }\n\n/* ---------- toolbar ---------- */\n\n.fmde-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: 0 0 auto;\n  height: 48px;\n  padding: 0 12px;\n  background: var(--fmde-panel);\n  border-bottom: 1px solid var(--fmde-border);\n  z-index: 30;\n}\n.fmde-tb-group {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  padding: 0 8px;\n  border-right: 1px solid var(--fmde-border-soft);\n  height: 30px;\n}\n.fmde-tb-group:first-child { padding-left: 0; }\n.fmde-tb-group:last-child, .fmde-tb-profile { border-right: none; }\n.fmde-tb-spacer { flex: 1 1 auto; }\n\n.fmde-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  height: 30px;\n  min-width: 30px;\n  padding: 0 6px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--fmde-text);\n  font: inherit;\n  font-weight: 600;\n  cursor: pointer;\n  transition: background-color 0.12s ease, color 0.12s ease;\n}\n.fmde-btn:hover:not(:disabled) { background: rgba(17, 24, 39, 0.06); }\n.fmde-btn:active:not(:disabled) { background: rgba(17, 24, 39, 0.1); }\n.fmde-btn:disabled { opacity: 0.35; cursor: default; }\n.fmde-btn.active, .fmde-btn.on {\n  background: var(--fmde-accent-soft);\n  color: var(--fmde-accent);\n}\n.fmde-btn svg { flex: 0 0 auto; }\n.fmde-btn-labeled { padding: 0 10px; }\n.fmde-btn-labeled span { white-space: nowrap; }\n.fmde-btn-sm { height: 24px; min-width: 24px; }\n.fmde-btn-sm svg { width: 13px; height: 13px; }\n.fmde-btn-unlock { color: var(--fmde-accent); }\n.fmde-zoom-label { min-width: 52px; font-variant-numeric: tabular-nums; }\n\n.fmde-profile-badge {\n  display: inline-flex;\n  align-items: center;\n  height: 22px;\n  padding: 0 9px;\n  border-radius: 999px;\n  background: rgba(17, 24, 39, 0.07);\n  color: var(--fmde-muted);\n  font-size: 11px;\n  font-weight: 700;\n  letter-spacing: 0.03em;\n  text-transform: uppercase;\n}\n.fmde-profile-badge-designer { background: var(--fmde-accent-soft); color: var(--fmde-accent); }\n\n/* fill profile: chrome collapses to a minimal bar */\n.fmde-minimal .fmde-rail, .fmde-minimal .fmde-inspector { display: none; }\n/* inline profile: no chrome at all — canvas only + popover inspector */\n.fmde-chromeless .fmde-toolbar, .fmde-chromeless .fmde-rail, .fmde-chromeless .fmde-inspector { display: none; }\n\n/* ---------- layout ---------- */\n\n.fmde-body {\n  display: flex;\n  flex: 1 1 auto;\n  min-height: 0;\n}\n\n.fmde-rail {\n  flex: 0 0 248px;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  background: var(--fmde-panel);\n  border-right: 1px solid var(--fmde-border);\n  z-index: 20;\n}\n.fmde-rail-tabs {\n  display: flex;\n  flex: 0 0 auto;\n  padding: 8px 8px 0;\n  gap: 2px;\n  border-bottom: 1px solid var(--fmde-border-soft);\n}\n.fmde-rail-tab {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  padding: 7px 10px 9px;\n  border: none;\n  border-bottom: 2px solid transparent;\n  background: transparent;\n  color: var(--fmde-muted);\n  font: inherit;\n  font-weight: 600;\n  cursor: pointer;\n}\n.fmde-rail-tab:hover { color: var(--fmde-text); }\n.fmde-rail-tab.active {\n  color: var(--fmde-accent);\n  border-bottom-color: var(--fmde-accent);\n}\n.fmde-rail-body {\n  flex: 1 1 auto;\n  overflow-y: auto;\n  padding: 10px;\n}\n\n.fmde-canvas {\n  position: relative;\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: auto;\n  background:\n    radial-gradient(rgba(17, 24, 39, 0.055) 1px, transparent 1px) 0 0 / 22px 22px,\n    var(--fmde-bg);\n}\n.fmde-canvas.fmde-placing { cursor: crosshair; }\n.fmde-stage {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 28px;\n  padding: 36px;\n  min-width: min-content;\n  min-height: 100%;\n}\n.fmde-stage .fmdoc-page {\n  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12), 0 12px 32px rgba(15, 23, 42, 0.12);\n  border-radius: 2px;\n}\n.fmde-render-error {\n  margin: 40px auto;\n  max-width: 460px;\n  padding: 16px 18px;\n  border: 1px solid #fca5a5;\n  border-radius: var(--fmde-radius);\n  background: #fef2f2;\n  color: #991b1b;\n  font-weight: 600;\n}\n\n.fmde-inspector {\n  flex: 0 0 272px;\n  overflow-y: auto;\n  background: var(--fmde-panel);\n  border-left: 1px solid var(--fmde-border);\n  padding: 12px;\n  z-index: 20;\n}\n\n/* ---------- hint / status pill ---------- */\n\n.fmde-hint {\n  position: sticky;\n  bottom: 14px;\n  left: 50%;\n  display: table;\n  margin: 0 auto;\n  padding: 8px 14px;\n  border-radius: 999px;\n  background: #111827;\n  color: #fff;\n  font-size: 12px;\n  font-weight: 700;\n  opacity: 0;\n  transform: translateY(10px);\n  transition: opacity 0.16s ease, transform 0.16s ease;\n  pointer-events: none;\n  z-index: 40;\n}\n.fmde-hint.show { opacity: 1; transform: translateY(0); }\n.fmde-hint.warn { background: #b91c1c; }\n\n/* ---------- overlay: selection, handles, guides, marquee ---------- */\n\n.fmde-overlay {\n  position: absolute;\n  inset: 0;\n  z-index: 500;\n  cursor: default;\n  /* --fmde-px is 1 visual pixel expressed in pt, set by the editor per zoom */\n}\n.fmde-overlay-pass { pointer-events: none; }\n.fmde-guides, .fmde-selboxes { position: absolute; inset: 0; pointer-events: none; }\n\n.fmde-selbox {\n  position: absolute;\n  border: calc(1.5 * var(--fmde-px, 1px)) solid var(--fmde-accent);\n  pointer-events: none;\n}\n.fmde-selbox.member { border-style: dashed; opacity: 0.85; }\n.fmde-selbox.multi { border-style: solid; }\n.fmde-selbox .fmde-handle,\n.fmde-selbox .fmde-handle-rotate { pointer-events: auto; }\n\n.fmde-handle {\n  position: absolute;\n  width: calc(9 * var(--fmde-px, 1px));\n  height: calc(9 * var(--fmde-px, 1px));\n  background: #fff;\n  border: calc(1.5 * var(--fmde-px, 1px)) solid var(--fmde-accent);\n  border-radius: calc(2 * var(--fmde-px, 1px));\n  box-shadow: 0 calc(1 * var(--fmde-px, 1px)) calc(3 * var(--fmde-px, 1px)) rgba(15, 23, 42, 0.25);\n}\n.fmde-handle-nw { left: 0; top: 0; transform: translate(-50%, -50%); cursor: nwse-resize; }\n.fmde-handle-n  { left: 50%; top: 0; transform: translate(-50%, -50%); cursor: ns-resize; }\n.fmde-handle-ne { left: 100%; top: 0; transform: translate(-50%, -50%); cursor: nesw-resize; }\n.fmde-handle-e  { left: 100%; top: 50%; transform: translate(-50%, -50%); cursor: ew-resize; }\n.fmde-handle-se { left: 100%; top: 100%; transform: translate(-50%, -50%); cursor: nwse-resize; }\n.fmde-handle-s  { left: 50%; top: 100%; transform: translate(-50%, -50%); cursor: ns-resize; }\n.fmde-handle-sw { left: 0; top: 100%; transform: translate(-50%, -50%); cursor: nesw-resize; }\n.fmde-handle-w  { left: 0; top: 50%; transform: translate(-50%, -50%); cursor: ew-resize; }\n\n.fmde-handle-rotate {\n  position: absolute;\n  left: 50%;\n  top: calc(-26 * var(--fmde-px, 1px));\n  transform: translate(-50%, 0);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: calc(20 * var(--fmde-px, 1px));\n  height: calc(20 * var(--fmde-px, 1px));\n  background: #fff;\n  border: calc(1.5 * var(--fmde-px, 1px)) solid var(--fmde-accent);\n  border-radius: 50%;\n  box-shadow: 0 calc(1 * var(--fmde-px, 1px)) calc(3 * var(--fmde-px, 1px)) rgba(15, 23, 42, 0.25);\n  color: var(--fmde-accent);\n  cursor: grab;\n}\n.fmde-handle-rotate svg { width: calc(12 * var(--fmde-px, 1px)); height: calc(12 * var(--fmde-px, 1px)); }\n.fmde-handle-rotate:active { cursor: grabbing; }\n\n.fmde-guide {\n  position: absolute;\n  background: var(--fmde-guide);\n  z-index: 5;\n}\n.fmde-guide-v { top: 0; bottom: 0; width: calc(1 * var(--fmde-px, 1px)); transform: translateX(-50%); }\n.fmde-guide-h { left: 0; right: 0; height: calc(1 * var(--fmde-px, 1px)); transform: translateY(-50%); }\n\n.fmde-marquee {\n  position: absolute;\n  display: none;\n  border: calc(1 * var(--fmde-px, 1px)) solid var(--fmde-accent);\n  background: rgba(37, 99, 235, 0.08);\n  pointer-events: none;\n}\n.fmde-marquee.show { display: block; }\n\n.fmde-hotspot {\n  position: absolute;\n  pointer-events: auto;\n  cursor: text;\n  border: calc(1.5 * var(--fmde-px, 1px)) dashed rgba(37, 99, 235, 0.55);\n  border-radius: calc(3 * var(--fmde-px, 1px));\n  background: rgba(37, 99, 235, 0.04);\n  transition: background-color 0.12s ease;\n}\n.fmde-hotspot:hover { background: rgba(37, 99, 235, 0.1); }\n\n/* ---------- in-place text editing ---------- */\n\n.fmde-textedit {\n  position: absolute;\n  pointer-events: auto;\n  z-index: 20;\n}\n.fmde-textedit-area {\n  min-height: 100%;\n  width: 100%;\n  outline: calc(2 * var(--fmde-px, 1px)) solid var(--fmde-accent);\n  outline-offset: calc(1 * var(--fmde-px, 1px));\n  background: rgba(255, 255, 255, 0.92);\n  padding: 0;\n  white-space: pre-wrap;\n  overflow-wrap: break-word;\n}\n.fmde-textedit-area:focus { outline-color: var(--fmde-accent); }\n.fmde-textbar {\n  position: absolute;\n  top: calc(-44 * var(--fmde-px, 1px));\n  left: 0;\n  display: flex;\n  gap: 2px;\n  padding: calc(3 * var(--fmde-px, 1px));\n  background: #fff;\n  border: 1px solid var(--fmde-border);\n  border-radius: 8px;\n  box-shadow: var(--fmde-shadow);\n  /* Counter the page zoom so the mini toolbar stays readable */\n  font-size: calc(12 * var(--fmde-px, 1px));\n}\n.fmde-textbar .fmde-btn {\n  height: calc(26 * var(--fmde-px, 1px));\n  min-width: calc(26 * var(--fmde-px, 1px));\n}\n.fmde-textbar .fmde-btn svg { width: calc(14 * var(--fmde-px, 1px)); height: calc(14 * var(--fmde-px, 1px)); }\n.fmde-textbar-done { color: var(--fmde-accent); padding: 0 calc(8 * var(--fmde-px, 1px)); }\n\n/* ---------- menus ---------- */\n\n.fmde-menu {\n  position: fixed;\n  z-index: 9500;\n  min-width: 180px;\n  padding: 5px;\n  background: #fff;\n  border: 1px solid var(--fmde-border);\n  border-radius: 10px;\n  box-shadow: var(--fmde-shadow);\n  font-family: Inter, ui-sans-serif, system-ui, sans-serif;\n  font-size: 13px;\n}\n.fmde-menu-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n  padding: 7px 9px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: #111827;\n  font: inherit;\n  font-weight: 500;\n  text-align: left;\n  cursor: pointer;\n}\n.fmde-menu-item:hover:not(.disabled) { background: rgba(17, 24, 39, 0.06); }\n.fmde-menu-item.disabled { opacity: 0.45; cursor: default; }\n.fmde-menu-item.checked { color: var(--fmde-accent, #2563eb); font-weight: 700; }\n.fmde-menu-ic { display: inline-flex; color: #6b7280; }\n.fmde-menu-label { flex: 1 1 auto; }\n.fmde-menu-check { display: inline-flex; color: var(--fmde-accent, #2563eb); }\n.fmde-menu-sep { height: 1px; margin: 5px 4px; background: rgba(17, 24, 39, 0.08); }\n\n/* ---------- left rail: pages ---------- */\n\n.fmde-page-list { display: flex; flex-direction: column; gap: 8px; }\n.fmde-page-card {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px;\n  border: 1px solid var(--fmde-border-soft);\n  border-radius: var(--fmde-radius);\n  background: #fff;\n  cursor: pointer;\n  transition: border-color 0.12s ease, box-shadow 0.12s ease;\n}\n.fmde-page-card:hover { border-color: var(--fmde-border); }\n.fmde-page-card.active {\n  border-color: var(--fmde-accent);\n  box-shadow: 0 0 0 1px var(--fmde-accent);\n}\n.fmde-page-card.dragover { border-color: var(--fmde-accent); border-style: dashed; }\n.fmde-page-num {\n  flex: 0 0 34px;\n  height: 44px;\n  display: grid;\n  place-items: center;\n  border-radius: 6px;\n  background: rgba(17, 24, 39, 0.05);\n  color: var(--fmde-muted);\n  font-weight: 800;\n  font-size: 15px;\n}\n.fmde-page-card.active .fmde-page-num { background: var(--fmde-accent-soft); color: var(--fmde-accent); }\n.fmde-page-meta { flex: 1 1 auto; min-width: 0; }\n.fmde-page-name {\n  font-weight: 700;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.fmde-page-role {\n  margin-top: 2px;\n  font-size: 11px;\n  font-weight: 700;\n  letter-spacing: 0.04em;\n  text-transform: uppercase;\n  color: var(--fmde-muted);\n}\n.fmde-page-actions { display: none; gap: 2px; }\n.fmde-page-card:hover .fmde-page-actions { display: flex; }\n\n.fmde-add-btn {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 7px;\n  width: 100%;\n  margin-top: 10px;\n  padding: 9px 0;\n  border: 1px dashed rgba(17, 24, 39, 0.25);\n  border-radius: var(--fmde-radius);\n  background: transparent;\n  color: var(--fmde-muted);\n  font: inherit;\n  font-weight: 700;\n  cursor: pointer;\n  transition: color 0.12s ease, border-color 0.12s ease;\n}\n.fmde-add-btn:hover { color: var(--fmde-accent); border-color: var(--fmde-accent); }\n.fmde-add-sm { margin-top: 6px; padding: 6px 0; font-size: 12px; }\n\n/* ---------- left rail: layers ---------- */\n\n.fmde-layers-head {\n  padding: 2px 4px 8px;\n  font-size: 11px;\n  font-weight: 800;\n  letter-spacing: 0.05em;\n  text-transform: uppercase;\n  color: var(--fmde-muted);\n}\n.fmde-layer-list { display: flex; flex-direction: column; gap: 1px; }\n.fmde-layer-row {\n  display: flex;\n  align-items: center;\n  gap: 7px;\n  padding: 6px 6px 6px 10px;\n  border-radius: 6px;\n  cursor: pointer;\n  user-select: none;\n}\n.fmde-layer-row:hover { background: rgba(17, 24, 39, 0.05); }\n.fmde-layer-row.selected { background: var(--fmde-accent-soft); }\n.fmde-layer-row.dragover { box-shadow: 0 -2px 0 var(--fmde-accent); }\n.fmde-layer-row.hidden-node .fmde-layer-name { opacity: 0.45; text-decoration: line-through; }\n.fmde-layer-ic { display: inline-flex; color: var(--fmde-muted); flex: 0 0 auto; }\n.fmde-layer-row.selected .fmde-layer-ic { color: var(--fmde-accent); }\n.fmde-layer-name {\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-weight: 600;\n}\n.fmde-layer-lock, .fmde-layer-eye { visibility: hidden; color: var(--fmde-muted); }\n.fmde-layer-row:hover .fmde-layer-lock,\n.fmde-layer-row:hover .fmde-layer-eye,\n.fmde-layer-lock.on, .fmde-layer-eye.on { visibility: visible; }\n.fmde-layer-lock.on { color: #b45309; }\n\n/* ---------- left rail: insert palette ---------- */\n\n.fmde-insert-section { margin-bottom: 16px; }\n.fmde-insert-title {\n  padding: 0 2px 8px;\n  font-size: 11px;\n  font-weight: 800;\n  letter-spacing: 0.05em;\n  text-transform: uppercase;\n  color: var(--fmde-muted);\n}\n.fmde-tile-grid {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 8px;\n}\n.fmde-tile {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 7px;\n  padding: 12px 6px 10px;\n  border: 1px solid var(--fmde-border-soft);\n  border-radius: var(--fmde-radius);\n  background: #fff;\n  color: var(--fmde-text);\n  font: inherit;\n  font-size: 12px;\n  font-weight: 600;\n  cursor: pointer;\n  transition: border-color 0.12s ease, transform 0.08s ease;\n}\n.fmde-tile:hover { border-color: var(--fmde-accent); color: var(--fmde-accent); }\n.fmde-tile:active { transform: scale(0.97); }\n.fmde-tile-ic { display: inline-flex; color: var(--fmde-muted); }\n.fmde-tile:hover .fmde-tile-ic { color: var(--fmde-accent); }\n.fmde-tile-ic svg { width: 20px; height: 20px; }\n.fmde-tile-badge {\n  display: grid;\n  place-items: center;\n  width: 26px;\n  height: 26px;\n  border-radius: 7px;\n  background: var(--fmde-accent-soft);\n  color: var(--fmde-accent);\n  font-weight: 800;\n  font-size: 13px;\n}\n\n/* ---------- inspector ---------- */\n\n.fmde-section { margin-bottom: 14px; }\n.fmde-section-title {\n  padding: 0 2px 7px;\n  font-size: 11px;\n  font-weight: 800;\n  letter-spacing: 0.05em;\n  text-transform: uppercase;\n  color: var(--fmde-muted);\n}\n.fmde-section-body {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.fmde-inspector-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 2px 2px 4px;\n  font-size: 14px;\n  font-weight: 800;\n}\n.fmde-inspector-type { display: inline-flex; color: var(--fmde-accent); }\n.fmde-widget-ref {\n  padding: 0 2px 2px;\n  font-size: 11px;\n  color: var(--fmde-muted);\n  font-family: ui-monospace, \"Cascadia Mono\", Consolas, monospace;\n}\n\n.fmde-field {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-height: 28px;\n}\n.fmde-field-label {\n  flex: 0 0 84px;\n  color: var(--fmde-muted);\n  font-weight: 600;\n  font-size: 12px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.fmde-field-control { flex: 1 1 auto; min-width: 0; display: flex; }\n.fmde-field-control > * { flex: 1 1 auto; min-width: 0; }\n.fmde-field-stack { flex-direction: column; align-items: stretch; }\n.fmde-field-stack .fmde-field-label { flex: 0 0 auto; padding-bottom: 4px; }\n.fmde-grid2 {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 6px 10px;\n}\n.fmde-grid2 .fmde-field-label { flex: 0 0 20px; }\n\n.fmde-input {\n  width: 100%;\n  height: 28px;\n  padding: 0 8px;\n  border: 1px solid var(--fmde-border);\n  border-radius: 6px;\n  background: #fff;\n  color: var(--fmde-text);\n  font: inherit;\n  font-size: 12.5px;\n}\n.fmde-input:focus {\n  outline: none;\n  border-color: var(--fmde-accent);\n  box-shadow: 0 0 0 2px var(--fmde-accent-soft);\n}\n.fmde-input:disabled { background: rgba(17, 24, 39, 0.04); color: var(--fmde-muted); }\n.fmde-input.invalid { border-color: #dc2626; box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.12); }\n.fmde-textarea { height: auto; padding: 6px 8px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }\n.fmde-select { appearance: auto; }\n\n.fmde-toggle {\n  position: relative;\n  flex: 0 0 auto !important;\n  width: 36px;\n  height: 20px;\n  padding: 0;\n  border: none;\n  border-radius: 999px;\n  background: rgba(17, 24, 39, 0.2);\n  cursor: pointer;\n  transition: background-color 0.15s ease;\n}\n.fmde-toggle.on { background: var(--fmde-accent); }\n.fmde-toggle:disabled { opacity: 0.4; cursor: default; }\n.fmde-toggle-knob {\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 16px;\n  height: 16px;\n  border-radius: 50%;\n  background: #fff;\n  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.3);\n  transition: left 0.15s ease;\n}\n.fmde-toggle.on .fmde-toggle-knob { left: 18px; }\n\n.fmde-colorfield { display: flex; align-items: center; gap: 6px; }\n.fmde-color-swatch {\n  flex: 0 0 28px;\n  width: 28px;\n  height: 28px;\n  padding: 2px;\n  border: 1px solid var(--fmde-border);\n  border-radius: 6px;\n  background: #fff;\n  cursor: pointer;\n}\n.fmde-color-text { flex: 1 1 auto; }\n\n.fmde-sliderfield { display: flex; align-items: center; gap: 8px; }\n.fmde-slider { flex: 1 1 auto; accent-color: var(--fmde-accent); }\n.fmde-slider-value {\n  flex: 0 0 34px;\n  text-align: right;\n  font-size: 11.5px;\n  color: var(--fmde-muted);\n  font-variant-numeric: tabular-nums;\n}\n\n.fmde-mediafield { display: flex; align-items: center; gap: 8px; }\n.fmde-media-name {\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--fmde-muted);\n  font-size: 12px;\n}\n.fmde-mediafield .fmde-btn { flex: 0 0 auto; border: 1px solid var(--fmde-border); }\n\n.fmde-bindingfield { display: flex; align-items: center; gap: 6px; }\n.fmde-btn-token { flex: 0 0 30px !important; border: 1px solid var(--fmde-border); color: var(--fmde-accent); }\n\n.fmde-listfield { display: flex; flex-direction: column; gap: 6px; }\n.fmde-list-row { display: flex; align-items: center; gap: 6px; }\n\n.fmde-align-grid {\n  display: grid;\n  grid-template-columns: repeat(4, minmax(0, 1fr));\n  gap: 4px;\n}\n.fmde-align-grid .fmde-btn { border: 1px solid var(--fmde-border-soft); }\n.fmde-align-text { grid-template-columns: repeat(3, minmax(0, 1fr)); }\n\n.fmde-empty {\n  padding: 14px 10px;\n  color: var(--fmde-muted);\n  font-size: 12.5px;\n  text-align: center;\n}\n\n/* ---------- inline popover ---------- */\n\n.fmde-popover {\n  position: absolute;\n  z-index: 600;\n  width: 264px;\n  max-height: 70%;\n  overflow-y: auto;\n  padding: 12px;\n  background: #fff;\n  border: 1px solid var(--fmde-border);\n  border-radius: 12px;\n  box-shadow: var(--fmde-shadow);\n}\n" + EDITOR_CSS_V2;

  // v3: collapsible side panels (rail + inspector). Kept as an appended block so
  // the v1/v2 stylesheet text stays byte-stable for diffing.
  const EDITOR_CSS_V3 = "\n/* ---------- v3: collapsible side panels ---------- */\n" +
    ".fmde-tile-ic i{font-size:20px}\n" +
    ".fmde-rail-collapse{margin-left:auto;align-self:center;flex:0 0 auto;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--fmde-muted);cursor:pointer}\n" +
    ".fmde-rail-collapse:hover{background:rgba(17,24,39,.06);color:var(--fmde-text)}\n" +
    ".fmde-rail-collapse svg{width:14px;height:14px}\n" +
    ".fmde-body{position:relative}\n" +
    ".fmde-insp-collapse{position:absolute;top:9px;right:9px;z-index:25;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--fmde-muted);cursor:pointer}\n" +
    ".fmde-insp-collapse:hover{background:rgba(17,24,39,.06);color:var(--fmde-text)}\n" +
    ".fmde-insp-collapse svg{width:14px;height:14px}\n" +
    ".fmde-side-expand{display:none;flex:0 0 24px;align-items:flex-start;justify-content:center;padding:12px 0;border:none;background:var(--fmde-panel);color:var(--fmde-muted);cursor:pointer;z-index:20}\n" +
    ".fmde-side-expand svg{width:14px;height:14px}\n" +
    ".fmde-side-expand:hover{color:var(--fmde-accent);background:rgba(17,24,39,.04)}\n" +
    ".fmde-side-expand-left{border-right:1px solid var(--fmde-border)}\n" +
    ".fmde-side-expand-right{border-left:1px solid var(--fmde-border)}\n" +
    ".fmde-rail-collapsed .fmde-rail{display:none}\n" +
    ".fmde-rail-collapsed .fmde-side-expand-left{display:flex}\n" +
    ".fmde-insp-collapsed .fmde-inspector{display:none}\n" +
    ".fmde-insp-collapsed .fmde-insp-collapse{display:none}\n" +
    ".fmde-insp-collapsed .fmde-side-expand-right{display:flex}\n" +
    ".fmde-minimal .fmde-side-expand,.fmde-chromeless .fmde-side-expand,.fmde-mode-doc .fmde-side-expand,.fmde-mode-preview .fmde-side-expand{display:none}\n" +
    ".fmde-minimal .fmde-insp-collapse,.fmde-chromeless .fmde-insp-collapse,.fmde-mode-doc .fmde-insp-collapse,.fmde-mode-preview .fmde-insp-collapse{display:none}\n" +
    "/* editor menus mount on document.body — they must clear fullscreen host overlays */\n" +
    ".fmde-menu{z-index:2147483420}\n" +
    "/* page width: fill/fixed segmented control (drag a section's side handle to set a fixed width) */\n" +
    ".fmde-widthseg{display:flex;gap:2px;padding:2px;border-radius:8px;background:rgba(17,24,39,.07);width:100%}\n" +
    ".fmde-widthbtn{flex:1 1 0;height:24px;border:none;border-radius:6px;background:transparent;color:var(--fmde-muted);font:inherit;font-size:12px;font-weight:700;cursor:pointer}\n" +
    ".fmde-widthbtn:hover:not(:disabled){color:var(--fmde-text)}\n" +
    ".fmde-widthbtn.active{background:#fff;color:var(--fmde-text);box-shadow:0 1px 2px rgba(15,23,42,.2)}\n" +
    ".fmde-widthbtn:disabled{opacity:.4;cursor:default}\n" +
    ".fmde-width-hint{padding:0 2px;font-size:11.5px;color:var(--fmde-muted)}\n" +
    "/* crop mode: translucent full image + solid viewport + zoom corners */\n" +
    ".fmde-mode-visual .fmdoc-page.fmde-crop-active,.fmde-mode-doc .fmdoc-page.fmde-crop-active{overflow:visible}\n" +
    ".fmde-cropui{position:absolute;inset:0;overflow:visible!important;pointer-events:none;z-index:30}\n" +
    ".fmde-cropui img{position:absolute;pointer-events:none;max-width:none;user-select:none}\n" +
    ".fmde-crop-ghost{opacity:.4}\n" +
    ".fmde-crop-viewport{position:absolute;overflow:hidden;pointer-events:none;border:calc(1*var(--fmde-px,1px)) solid rgba(255,255,255,.95);box-shadow:0 0 0 calc(1*var(--fmde-px,1px)) rgba(17,24,39,.4)}\n" +
    ".fmde-crop-object-preview{position:absolute;z-index:2;display:flex;box-sizing:border-box;pointer-events:none;opacity:.48;overflow:hidden}\n" +
    ".fmde-crop-object-text{display:flex;width:100%;height:100%;box-sizing:border-box;padding:6pt;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2}\n" +
    ".fmde-crop-imgbox{position:absolute;pointer-events:auto;cursor:move;border:calc(1.5*var(--fmde-px,1px)) solid var(--fmde-accent)}\n" +
    ".fmde-crop-handle{position:absolute;width:calc(13*var(--fmde-px,1px));height:calc(13*var(--fmde-px,1px));background:#fff;border:calc(2*var(--fmde-px,1px)) solid var(--fmde-accent);border-radius:50%;box-shadow:0 calc(1*var(--fmde-px,1px)) calc(3*var(--fmde-px,1px)) rgba(15,23,42,.3);pointer-events:auto}\n" +
    ".fmde-crop-handle-nw{left:0;top:0;transform:translate(-50%,-50%);cursor:nwse-resize}\n" +
    ".fmde-crop-handle-ne{left:100%;top:0;transform:translate(-50%,-50%);cursor:nesw-resize}\n" +
    ".fmde-crop-handle-sw{left:0;top:100%;transform:translate(-50%,-50%);cursor:nesw-resize}\n" +
    ".fmde-crop-handle-se{left:100%;top:100%;transform:translate(-50%,-50%);cursor:nwse-resize}\n" +
    "/* Canva-style handles: round corner balls, pill edge grips */\n" +
    ".fmde-handle{border-radius:999px;width:calc(10*var(--fmde-px,1px));height:calc(10*var(--fmde-px,1px))}\n" +
    ".fmde-handle-n,.fmde-handle-s{width:calc(19*var(--fmde-px,1px));height:calc(7*var(--fmde-px,1px))}\n" +
    ".fmde-handle-e,.fmde-handle-w{width:calc(7*var(--fmde-px,1px));height:calc(19*var(--fmde-px,1px))}\n" +
    "/* Pages clip their content (overflow:hidden), which also clipped the\n" +
    "   selection overlay: any element touching the page edge had unusable\n" +
    "   resize handles, and clicking one cleared the selection instead. On the\n" +
    "   website surface the canvas shows overflow so edge handles stay grabbable. */\n" +
    ".fmde-profile-website .fmde-stage .fmdoc-page{overflow:visible}\n" +
    "/* v4 inspector: selection-driven widget controls and collapsible groups */\n" +
    ".fmde-inspector{flex:0 1 336px;width:336px;min-width:288px;max-width:40vw;padding:12px 10px}\n" +
    ".fmde-section-collapsible{border:1px solid var(--fmde-border-soft);border-radius:9px;background:#fff;overflow:hidden}\n" +
    ".fmde-section-collapsible>.fmde-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px;list-style:none;padding:10px 11px;cursor:pointer;color:#475467;background:#fff}\n" +
    ".fmde-section-collapsible>.fmde-section-title::-webkit-details-marker{display:none}\n" +
    ".fmde-section-collapsible>.fmde-section-title .fmde-section-chevron{display:inline-flex;transition:transform .15s ease}\n" +
    ".fmde-section-collapsible[open]>.fmde-section-title .fmde-section-chevron{transform:rotate(90deg)}\n" +
    ".fmde-section-collapsible>.fmde-section-body{padding:0 11px 11px}\n" +
    ".fmde-widget-controls{padding:11px;border:1px solid color-mix(in srgb,var(--fmde-accent) 30%,var(--fmde-border-soft));border-radius:11px;background:#fff;box-shadow:0 3px 12px rgba(15,23,42,.06)}\n" +
    ".fmde-widget-controls>.fmde-section-body{gap:10px}\n" +
    ".fmde-widget-controls-head{display:flex;align-items:center;gap:8px;min-width:0}\n" +
    ".fmde-widget-controls-head strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#101828}\n" +
    ".fmde-widget-controls-head .fmde-widget-ref{flex:0 0 auto;margin:0;padding:3px 6px;border-radius:999px;background:var(--fmde-accent-soft);color:var(--fmde-accent);font-size:9px;opacity:1}\n" +
    ".fmde-widget-group{margin:2px 0 0;border-radius:8px;background:#fafbfc}\n" +
    ".fmde-widget-group>.fmde-section-title{padding:9px 10px;font-size:10px;background:#fafbfc}\n" +
    ".fmde-widget-group>.fmde-section-body{padding:2px 10px 10px}\n" +
    ".fmde-widget-ref{opacity:.72}\n";

  // v5: tabbed right tray (Inspect + host side panels). The tab strip reuses
  // the rail-tab look; panel hosts stretch so embedded chrome (agent chat,
  // setup forms) can own their scrolling.
  const EDITOR_CSS_V5 = "\n/* ---------- v5: tabbed inspector (host side panels) ---------- */\n" +
    ".fmde-insp-tabs{display:flex;flex:0 0 auto;padding:8px 8px 0;gap:2px;border-bottom:1px solid var(--fmde-border-soft);background:var(--fmde-panel)}\n" +
    ".fmde-insp-tabs[hidden]{display:none}\n" +
    ".fmde-has-panels:not(.fmde-insp-collapsed) .fmde-inspector{display:flex;flex-direction:column;padding:0}\n" +
    ".fmde-has-panels .fmde-insp-inspect{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 10px}\n" +
    ".fmde-insp-inspect[hidden]{display:none}\n" +
    ".fmde-insp-panels{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n" +
    ".fmde-insp-panels[hidden]{display:none}\n" +
    ".fmde-insp-panel{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}\n" +
    ".fmde-insp-panel[hidden]{display:none}\n" +
    "/* Doc mode normally hides the inspector; with host panels the tray stays\n" +
    "   available (showing only panel tabs — Inspect is visual-mode only). */\n" +
    ".fmde-mode-doc.fmde-has-panels:not(.fmde-insp-collapsed) .fmde-inspector{display:flex}\n" +
    ".fmde-mode-doc.fmde-has-panels .fmde-insp-collapse{display:inline-flex}\n" +
    ".fmde-mode-doc.fmde-has-panels.fmde-insp-collapsed .fmde-insp-collapse{display:none}\n" +
    ".fmde-mode-doc.fmde-has-panels.fmde-insp-collapsed .fmde-side-expand-right{display:flex}\n" +
    "/* Preview remains presentation-first, with Agent as its one permitted tray. */\n" +
    ".fmde-mode-preview.fmde-preview-agent:not(.fmde-insp-collapsed) .fmde-inspector{display:flex;flex-direction:column;padding:0}\n" +
    ".fmde-mode-preview.fmde-preview-agent:not(.fmde-insp-collapsed) .fmde-insp-collapse{display:inline-flex}\n" +
    ".fmde-mode-preview.fmde-preview-agent.fmde-insp-collapsed .fmde-side-expand-right{display:flex}\n" +
    ".fmde-preview-agent .fmde-preview-agent-btn.active{background:var(--fmde-accent-soft);color:var(--fmde-accent)}\n";

  const EDITOR_CSS_V6 = "\n/* ---------- v6: word-processing document surface ---------- */\n" +
    ".fmde-mode-doc .fmde-toolbar{gap:0;overflow:hidden;padding:0 7px;container-type:inline-size}\n" +
    ".fmde-mode-doc .fmde-tb-group{flex:0 0 auto;padding:0 3px;gap:0}\n" +
    ".fmde-mode-doc .fmde-btn{height:28px;min-width:26px;padding:0 3px;gap:3px}\n" +
    ".fmde-mode-doc .fmde-modebtn{padding:0 7px}\n" +
    ".fmde-mode-doc .fmde-zoom-label{min-width:43px}\n" +
    ".fmde-mode-doc .fmde-styleselect{min-width:100px;max-width:112px}\n" +
    ".fmde-mode-doc .fmde-fontselect{min-width:86px;max-width:104px;justify-content:space-between}\n" +
    ".fmde-mode-doc .fmde-fontsize{min-width:32px;border:1px solid var(--fmde-border);font-variant-numeric:tabular-nums}\n" +
    ".fmde-mode-doc .fmde-tb-advanced{margin-left:auto}\n" +
    ".fmde-tb-version{border-right:0;border-left:1px solid var(--fmde-border-soft)}.fmde-version-history-btn{color:var(--fmde-muted)}.fmde-version-history-btn:hover:not(:disabled){color:var(--fmde-accent)}\n" +
    ".fmde-tool-color{position:relative;padding-bottom:4px!important}\n" +
    ".fmde-tool-color-line{position:absolute;left:5px;right:5px;bottom:2px;height:3px;border-radius:2px;background:var(--tool-color,#202124);box-shadow:inset 0 0 0 1px rgba(0,0,0,.09)}\n" +
    ".fmde-color-menu{width:254px;padding:10px}\n" +
    ".fmde-color-grid{display:grid;grid-template-columns:repeat(10,20px);gap:3px}\n" +
    ".fmde-color-chip{width:20px;height:20px;padding:0;border:1px solid rgba(17,24,39,.16);border-radius:50%;cursor:pointer;position:relative}\n" +
    ".fmde-color-chip:hover,.fmde-color-chip.selected{outline:2px solid var(--fmde-accent);outline-offset:1px}\n" +
    ".fmde-color-custom{display:flex;align-items:center;gap:8px;margin-top:9px;padding-top:8px;border-top:1px solid var(--fmde-border-soft);font-size:12px;font-weight:650}\n" +
    ".fmde-color-custom input{margin-left:auto;width:34px;height:24px;padding:1px;border:1px solid var(--fmde-border);border-radius:5px;background:#fff}\n" +
    ".fmde-color-none{background:linear-gradient(135deg,#fff 46%,#e53935 47%,#e53935 54%,#fff 55%)}\n" +
    ".fmde-color-opacity{display:grid;gap:6px;margin-top:9px;padding-top:8px;border-top:1px solid var(--fmde-border-soft)}.fmde-color-opacity-head{display:flex;justify-content:space-between;color:#5f6368;font-size:11px;font-weight:700}.fmde-color-opacity input{width:100%;accent-color:var(--fmde-accent)}.fmde-color-remove-image{display:flex;align-items:center;gap:8px;width:100%;margin-top:9px;padding:8px 9px;border:0;border-top:1px solid var(--fmde-border-soft);background:transparent;color:#c5221f;font:inherit;font-weight:650;text-align:left;cursor:pointer}.fmde-color-remove-image:hover{background:#fce8e6}.fmde-color-remove-image svg{width:15px;height:15px}\n" +
    ".fmde-color-frequent{margin-top:9px;padding-top:8px;border-top:1px solid var(--fmde-border-soft)}.fmde-color-frequent-label{margin-bottom:6px;color:#5f6368;font-size:10px;font-weight:750}.fmde-color-frequent-row{display:grid;grid-template-columns:repeat(10,20px);gap:3px}.fmde-color-chip.brand{box-shadow:inset 0 0 0 2px #fff,0 0 0 1px var(--fmde-accent)}\n" +
    ".fmde-menu{max-height:calc(100vh - 60px);overflow-y:auto}\n" +
    ".fmde-overflowed{display:none!important}\n" +
    "@container (max-width:1120px){.fmde-doc-list{display:none!important}}\n" +
    "@container (max-width:980px){.fmde-doc-para{display:none!important}}\n" +
    "@container (max-width:880px){.fmde-doc-insert{display:none!important}}\n" +
    "@container (max-width:760px){.fmde-doc-utility{display:none!important}.fmde-doc-style{display:none!important}}\n" +
    "@container (max-width:610px){.fmde-doc-format{display:none!important}}\n" +
    "@container (max-width:520px){.fmde-doc-zoom{display:none!important}}\n" +
    "@container (max-width:390px){.fmde-doc-history{display:none!important}}\n" +
    ".fmde-mode-doc [data-page-region]{outline:1px solid transparent;outline-offset:3px;transition:outline-color .12s ease,background-color .12s ease}\n" +
    ".fmde-mode-doc [data-page-region]:hover{outline-color:rgba(95,99,104,.2)}\n" +
    ".fmde-mode-doc [data-page-region]:focus-within{outline-color:rgba(26,115,232,.42);background:rgba(26,115,232,.018)}\n" +
    ".fmde-mode-doc.fmde-caret-passive [data-page-region]:focus-within{outline-color:transparent;background:transparent}\n" +
    ".fmde-mode-doc [data-page-region=header]:focus-within:before,.fmde-mode-doc [data-page-region=footer]:focus-within:before{position:absolute;right:0;top:-14px;color:#5f6368;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}\n" +
    ".fmde-mode-doc [data-page-region=header]:focus-within:before{content:'Header'}\n" +
    ".fmde-mode-doc [data-page-region=footer]:focus-within:before{content:'Footer'}\n" +
    "/* Explicit page boundaries are communicated by the page itself. */\n" +
    ".fmde-mode-doc .fmdoc-page_break,.fmde-mode-visual .fmdoc-page_break{overflow:hidden!important}\n" +
    ".fmde-mode-doc .fmdoc-page_break::before,.fmde-mode-doc .fmdoc-page_break::after,.fmde-mode-visual .fmdoc-page_break::before,.fmde-mode-visual .fmdoc-page_break::after{content:none!important;display:none!important}\n";

  const EDITOR_CSS_V7 = "\n/* ---------- v7: anchored document comments ---------- */\n" +
    ".fmde-stage{position:relative}\n" +
    ".fmde-comment-anchor{background:rgba(255,212,64,.22);box-shadow:inset 3px 0 #f9ab00}\n" +
    ".fmde-comment-card{position:absolute;z-index:760;width:250px;padding:11px 11px 10px;border:1px solid rgba(15,23,42,.14);border-radius:11px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.16);font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#202124}\n" +
    ".fmde-comment-card:before{content:'';position:absolute;left:-9px;top:16px;width:16px;height:16px;background:#fff;border-left:1px solid rgba(15,23,42,.14);border-bottom:1px solid rgba(15,23,42,.14);transform:rotate(45deg)}\n" +
    ".fmde-comment-head{position:relative;display:flex;align-items:center;gap:8px;margin-bottom:7px}\n" +
    ".fmde-comment-avatar{width:27px;height:27px;display:grid;place-items:center;border-radius:50%;background:var(--fmde-accent);color:var(--fmde-on-accent,#fff);font-size:10px;font-weight:800;text-transform:uppercase;flex:none}\n" +
    ".fmde-comment-who{min-width:0;display:flex;flex-direction:column;font-size:11px;line-height:1.25}.fmde-comment-who strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fmde-comment-who time{font-size:9.5px;color:#80868b}\n" +
    ".fmde-comment-text{position:relative;font-size:12px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}\n" +
    ".fmde-comment-quote{margin:0 0 7px;padding:5px 7px;border-left:2px solid #f9ab00;background:#fff8d8;color:#5f6368;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n" +
    ".fmde-comment-reply{margin-top:8px;padding-top:8px;border-top:1px solid #edf0f3}.fmde-comment-reply .fmde-comment-head{margin-bottom:4px}.fmde-comment-reply .fmde-comment-avatar{width:22px;height:22px;font-size:8px}\n" +
    ".fmde-comment-compose{display:flex;gap:6px;margin-top:9px}.fmde-comment-compose input{min-width:0;flex:1;height:29px;border:1px solid #dadce0;border-radius:7px;padding:0 8px;font:inherit;font-size:11px}.fmde-comment-compose button,.fmde-comment-actions button{border:0;border-radius:7px;background:transparent;color:var(--fmde-accent);font:inherit;font-size:10.5px;font-weight:750;cursor:pointer;padding:5px 7px}.fmde-comment-compose button{background:var(--fmde-accent);color:var(--fmde-on-accent,#fff)}\n" +
    ".fmde-comment-draft textarea{display:block;width:100%;min-height:72px;resize:vertical;border:1px solid #dadce0;border-radius:8px;padding:8px;font:inherit;font-size:12px;line-height:1.4;outline:none}.fmde-comment-draft textarea:focus{border-color:var(--fmde-accent);box-shadow:0 0 0 2px var(--fmde-accent-soft)}\n" +
    ".fmde-comment-actions{display:flex;justify-content:flex-end;gap:3px;margin-top:5px}\n" +
    ".fmde-suggestion-card{border-color:rgba(124,58,237,.28)}.fmde-suggestion-card:before{border-color:rgba(124,58,237,.28)}.fmde-suggestion-card .fmde-comment-avatar{background:#7c3aed}\n" +
    ".fmde-suggestion-change{display:grid;grid-template-columns:auto 1fr;gap:3px 7px;font-size:11px;line-height:1.35}.fmde-suggestion-change b{color:#80868b}.fmde-suggestion-before{text-decoration:line-through;color:#b3261e}.fmde-suggestion-after{color:#137333;font-weight:650}\n" +
    ".fmde-comment-actions [data-accept-suggestion]{background:#7c3aed;color:#fff}.fmde-comment-actions [data-reject-suggestion]{color:#5f6368}\n";

  const EDITOR_CSS_V8 = "\n/* ---------- v8: familiar document menubar ---------- */\n" +
    ".fmde-menubar{display:none;align-items:center;gap:1px;flex:0 0 34px;padding:2px 8px;background:var(--fmde-panel);border-bottom:1px solid var(--fmde-border-soft);z-index:32;overflow:hidden}\n" +
    ".fmde-mode-doc .fmde-menubar{display:flex}.fmde-menu-search-btn,.fmde-menubar-btn{height:28px;border:0;border-radius:6px;background:transparent;color:var(--fmde-text);font:inherit;cursor:pointer;white-space:nowrap}.fmde-menubar-btn{padding:0 9px;font-weight:550}.fmde-menubar-btn:hover,.fmde-menubar-btn.active{background:rgba(17,24,39,.07)}\n" +
    ".fmde-menu-search-btn{display:flex;align-items:center;gap:7px;width:106px;padding:0 10px;margin-right:4px;background:rgba(17,24,39,.045);color:var(--fmde-muted);text-align:left}.fmde-menu-search-btn svg{width:15px;height:15px}\n" +
    ".fmde-menu-item{min-height:34px}.fmde-menu-shortcut{margin-left:28px;color:#9aa0a6;font-weight:600;white-space:nowrap}.fmde-menu-arrow{margin-left:12px;color:#9aa0a6}.fmde-menu-heading{padding:7px 10px 4px;color:#6b7280;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}\n" +
    ".fmde-object-layout{position:absolute;right:calc(-1px * var(--fmde-px,1));top:calc(-34px * var(--fmde-px,1));display:flex;gap:calc(2px * var(--fmde-px,1));padding:calc(3px * var(--fmde-px,1));border:calc(1px * var(--fmde-px,1)) solid #d7dce3;border-radius:calc(7px * var(--fmde-px,1));background:#fff;box-shadow:0 calc(4px * var(--fmde-px,1)) calc(14px * var(--fmde-px,1)) rgba(15,23,42,.16);pointer-events:auto;transform:none}.fmde-object-layout button{width:calc(25px * var(--fmde-px,1));height:calc(24px * var(--fmde-px,1));padding:0;border:0;border-radius:calc(5px * var(--fmde-px,1));background:transparent;color:#667085;font-size:calc(12px * var(--fmde-px,1));cursor:pointer}.fmde-object-layout button:hover,.fmde-object-layout button.active{background:var(--fmde-accent-soft);color:var(--fmde-accent)}\n" +
    ".fmde-mode-doc .fmdoc-page-content,.fmde-mode-doc [data-chain],.fmde-mode-doc .fmdoc-text:has(.fmdoc-widget){overflow:visible!important}\n" +
    ".fmde-mode-doc [data-fmde-doc-placeholder]{cursor:text;outline:1px dashed rgba(95,99,104,.16);outline-offset:2px}.fmde-mode-doc [data-fmde-doc-placeholder]:hover{outline-color:rgba(26,115,232,.42);background:rgba(26,115,232,.018)}.fmde-doc-add-page{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;padding:0;border:1px solid #cfd5dd;border-radius:50%;background:#fff;color:#5f6368;box-shadow:0 2px 7px rgba(15,23,42,.12);cursor:pointer}.fmde-doc-add-page:hover,.fmde-doc-add-page:focus-visible{border-color:var(--fmde-accent);background:var(--fmde-accent-soft);color:var(--fmde-accent);outline:none}.fmde-doc-add-page svg{width:16px;height:16px}\n" +
    ".fmde-mode-doc .fmdoc-node.fmde-doc-object{cursor:move}.fmde-mode-doc .fmdoc-node.fmde-doc-object.fmde-doc-object-dragging{pointer-events:none;opacity:.86}.fmde-doc-object-chrome{position:absolute;z-index:9000;border:2px solid var(--fmde-accent);pointer-events:none}.fmde-doc-object-controls{position:absolute;right:-2px;bottom:calc(100% + 4px);z-index:1;display:flex;gap:2px;padding:3px;border:1px solid #d7dce3;border-radius:7px;background:#fff;box-shadow:0 4px 14px rgba(15,23,42,.16);user-select:none;pointer-events:auto}.fmde-doc-object-controls button{display:grid;place-items:center;width:30px;height:28px;padding:0;border:0;border-radius:5px;background:transparent;color:#667085;cursor:pointer}.fmde-doc-object-controls button svg{display:block;width:24px;height:20px;overflow:visible}.fmde-doc-object-controls button:hover,.fmde-doc-object-controls button.active{background:var(--fmde-accent-soft);color:var(--fmde-accent)}.fmde-doc-object-resize{position:absolute;z-index:2;width:10px;height:10px;border:2px solid var(--fmde-accent);border-radius:2px;background:#fff;pointer-events:auto;transform:translate(-50%,-50%)}.fmde-doc-resize-nw{left:0;top:0;cursor:nwse-resize}.fmde-doc-resize-n{left:50%;top:0;cursor:ns-resize}.fmde-doc-resize-ne{left:100%;top:0;cursor:nesw-resize}.fmde-doc-resize-e{left:100%;top:50%;cursor:ew-resize}.fmde-doc-resize-se{left:100%;top:100%;cursor:nwse-resize}.fmde-doc-resize-s{left:50%;top:100%;cursor:ns-resize}.fmde-doc-resize-sw{left:0;top:100%;cursor:nesw-resize}.fmde-doc-resize-w{left:0;top:50%;cursor:ew-resize}.fmde-doc-object-resize.fmde-resize-axis-x{cursor:ew-resize}.fmde-doc-object-resize.fmde-resize-axis-y{cursor:ns-resize}.fmde-doc-object-resize.fmde-resize-locked{opacity:.38;cursor:not-allowed}.fmde-doc-guide{position:absolute;z-index:8999;background:var(--fmde-guide);pointer-events:none}.fmde-doc-guide-v{width:1px;transform:translateX(-50%)}.fmde-doc-guide-h{height:1px;transform:translateY(-50%)}\n" +
    ".fmde-menu{border:1px solid var(--fmde-border,#d7dce3);box-shadow:var(--fmde-shadow,0 8px 24px rgba(15,23,42,.16));transform-origin:top left;animation:fmde-menu-enter 110ms cubic-bezier(.2,.8,.2,1) both}.fmde-menu.fmde-submenu{animation-name:fmde-submenu-enter}@keyframes fmde-menu-enter{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes fmde-submenu-enter{from{opacity:0;transform:translateX(-4px) scale(.985)}to{opacity:1;transform:translateX(0) scale(1)}}@media(prefers-reduced-motion:reduce){.fmde-menu{animation:none}}\n" +
    ".fmde-command-menu{width:360px;max-width:calc(100vw - 16px);padding:8px}.fmde-command-search{width:100%;height:36px;border:1px solid var(--fmde-border);border-radius:8px;padding:0 10px;font:inherit;outline:none}.fmde-command-results{max-height:360px;overflow:auto;margin-top:6px}\n" +
    ".fmde-dialog-backdrop{position:fixed;inset:0;z-index:9600;display:grid;place-items:center;background:rgba(15,23,42,.28)}.fmde-dialog{width:min(480px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;border-radius:12px;background:#fff;box-shadow:0 22px 60px rgba(15,23,42,.28);padding:18px}.fmde-dialog h2{margin:0 0 14px;font-size:17px}.fmde-dialog-grid{display:grid;gap:10px}.fmde-dialog label{display:grid;gap:5px;font-size:11px;font-weight:750;color:#5f6368}.fmde-dialog input,.fmde-dialog select{height:36px;border:1px solid #dadce0;border-radius:7px;padding:0 9px;font:inherit}.fmde-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.fmde-dialog-actions button{height:32px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--fmde-accent);font:inherit;font-weight:750;cursor:pointer}.fmde-dialog-actions button.primary{background:var(--fmde-accent);color:var(--fmde-on-accent,#fff)}\n" +
    ".fmde-page-presets,.fmde-download-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:14px}.fmde-page-presets button,.fmde-download-grid button{display:grid;gap:3px;padding:10px;border:1px solid #dadce0;border-radius:9px;background:#fff;text-align:left;cursor:pointer}.fmde-page-presets button:hover,.fmde-download-grid button:hover{border-color:var(--fmde-accent);background:var(--fmde-accent-soft)}.fmde-page-presets span,.fmde-download-grid span,.fmde-dialog-note{color:#6b7280;font-size:11px}.fmde-page-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fmde-page-margin-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.fmde-dialog-subhead{margin:16px 0 8px;font-size:12px}.fmde-check-label{display:flex!important;align-items:center;gap:8px!important}.fmde-check-label input{width:16px;height:16px}.fmde-download-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fmde-shortcut-search{width:100%;margin-bottom:10px}.fmde-shortcut-list{max-height:52vh;overflow:auto;padding-right:4px}.fmde-shortcut-section h3{margin:12px 0 5px;color:#5f6368;font-size:11px;text-transform:uppercase;letter-spacing:.06em}.fmde-shortcut-row{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:34px;border-bottom:1px solid #f1f3f4;font-size:12px}.fmde-shortcut-row kbd{padding:4px 7px;border:1px solid #d5d9df;border-bottom-width:2px;border-radius:6px;background:#f8f9fa;color:#3c4043;font:600 11px ui-monospace,monospace;white-space:nowrap}.fmde-print-layout-off .fmde-stage{gap:1px!important}.fmde-print-layout-off .fmdoc-page{box-shadow:none!important;border-radius:0!important}.fmde-print-layout-off .fmdoc-page+.fmdoc-page{border-top:1px dashed #c5c9cf}\n" +
    ".fmde-dialog *{box-sizing:border-box}.fmde-dialog input,.fmde-dialog select{min-width:0;width:100%}.fmde-page-setup-dialog{width:min(920px,calc(100vw - 32px));overflow-x:hidden;padding:22px 24px}.fmde-page-setup-dialog>h2{font-size:20px}.fmde-page-setup-dialog .fmde-dialog-actions{position:sticky;bottom:-22px;margin:20px -24px -22px;padding:14px 24px;background:#fff;border-top:1px solid #e5e7eb;z-index:2}.fmde-dialog .fmde-dialog-actions button.primary{background:var(--fmde-accent,#2563eb)!important;color:var(--fmde-on-accent,#fff)!important;border:1px solid var(--fmde-accent,#2563eb)!important;min-width:108px}.fmde-dialog .fmde-dialog-actions button.primary:disabled{opacity:.65}.fmde-page-section-head{display:flex;align-items:baseline;gap:10px;margin:0 0 10px}.fmde-page-section-head h3{margin:0;font-size:13px}.fmde-page-section-head span{color:#6b7280;font-size:11px}.fmde-template-section{margin-bottom:22px}.fmde-template-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.fmde-template-card{display:grid;grid-template-columns:42px 1fr;grid-template-rows:auto auto;column-gap:10px;align-items:center;min-width:0;padding:10px;border:1px solid #d8dde5;border-radius:10px;background:#fff;text-align:left;cursor:pointer}.fmde-template-card:hover,.fmde-template-card.selected{border-color:var(--fmde-accent);box-shadow:0 0 0 1px var(--fmde-accent)}.fmde-template-card.selected{background:var(--fmde-accent-soft)}.fmde-template-preview{grid-row:1/3;width:38px;height:50px;padding:9px 6px;border:1px solid #d8dde5;border-radius:4px;background:#fff;box-shadow:0 2px 5px rgba(15,23,42,.08)}.fmde-template-preview i{display:block;height:3px;margin-bottom:4px;border-radius:2px;background:#9fb9ed}.fmde-template-preview i:nth-child(2){width:75%;background:#c7cdd6}.fmde-template-preview i:nth-child(3){width:88%;background:#dfe3e8}.fmde-template-card b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.fmde-template-card small{min-width:0;color:#6b7280;font-size:10px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fmde-page-options{padding-top:18px;border-top:1px solid #e5e7eb}.fmde-page-margin-grid>label,.fmde-page-grid>label{min-width:0}.fmde-symbol-menu{display:grid;grid-template-columns:repeat(5,42px);gap:4px;min-width:0!important;padding:8px}.fmde-symbol-menu .fmde-menu-item{display:grid;place-items:center;width:42px;height:42px;padding:0;font-size:20px}.fmde-symbol-menu .fmde-menu-label{flex:none}.fmde-shortcut-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 24px;align-items:start}.fmde-shortcut-section{break-inside:avoid;min-width:0}\n" +
    ".fmde-page-color-row{display:flex;align-items:flex-end;justify-content:flex-start;gap:18px;margin-top:12px}.fmde-page-color-field{display:grid!important;gap:5px!important;width:auto!important;color:#5f6368;font-size:11px;font-weight:750}.fmde-dialog .fmde-page-color-swatch{width:38px!important;min-width:38px;height:38px;padding:3px;border:1px solid #dadce0;border-radius:7px;background:#fff;cursor:pointer}.fmde-page-color-toggle{display:flex!important;align-items:center;gap:8px!important;width:auto!important;min-height:38px;color:#3c4043;font-size:12px;font-weight:650;cursor:pointer}.fmde-dialog .fmde-page-color-toggle input{width:16px!important;min-width:16px;height:16px;margin:0}.fmde-page-color-row.color-off .fmde-page-color-swatch{opacity:.45;cursor:default}\n" +
    ".fmde-style-card .fmde-template-preview{position:relative;overflow:hidden;padding:0}.fmde-style-card .fmde-template-preview i{position:absolute;margin:0;border-radius:0}.fmde-style-card .fmde-template-preview.none i{left:7px;right:7px;height:2px;background:#d6dbe3}.fmde-style-card .fmde-template-preview.none i:nth-child(1){top:13px}.fmde-style-card .fmde-template-preview.none i:nth-child(2){top:21px;width:auto}.fmde-style-card .fmde-template-preview.none i:nth-child(3){top:29px;width:auto}.fmde-style-card .fmde-template-preview.triangles:before,.fmde-style-card .fmde-template-preview.triangles:after{content:'';position:absolute;background:var(--fmde-accent)}.fmde-style-card .fmde-template-preview.triangles:before{left:0;top:0;width:23px;height:20px;clip-path:polygon(0 0,100% 0,0 100%)}.fmde-style-card .fmde-template-preview.triangles:after{right:0;bottom:0;width:17px;height:19px;clip-path:polygon(100% 0,100% 100%,0 100%);opacity:.45}.fmde-style-card .fmde-template-preview.left-border:before{content:'';position:absolute;inset:0 auto 0 0;width:7px;background:var(--fmde-accent);box-shadow:3px 0 color-mix(in srgb,var(--fmde-accent) 25%,transparent)}.fmde-style-card .fmde-template-preview.simple:before{content:'';position:absolute;inset:0 0 auto;height:9px;background:var(--fmde-accent-soft);border-bottom:2px solid var(--fmde-accent)}.fmde-style-card .fmde-template-preview:not(.none) i{left:11px;right:5px;height:2px;background:#d6dbe3}.fmde-style-card .fmde-template-preview:not(.none) i:nth-child(1){top:19px}.fmde-style-card .fmde-template-preview:not(.none) i:nth-child(2){top:27px;width:auto}.fmde-style-card .fmde-template-preview:not(.none) i:nth-child(3){top:35px;width:auto}\n" +
    "@media(min-width:1180px){.fmde-dialog:has(.fmde-shortcut-list){width:min(920px,calc(100vw - 32px))}.fmde-shortcut-list{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:720px){.fmde-page-setup-dialog{padding:18px}.fmde-template-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fmde-page-margin-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fmde-page-setup-dialog .fmde-dialog-actions{margin-left:-18px;margin-right:-18px;padding-left:18px;padding-right:18px}.fmde-shortcut-list{grid-template-columns:1fr}.fmde-page-section-head{display:grid;gap:3px}}\n" +
    ".fmde-show-nonprinting .fmde-docedit .fmdoc-block--paragraph::after{content:' ¶';color:#a8b0bb;font-weight:400}.fmde-comments-hidden .fmde-comment-card{display:none!important}.fmde-comments-hidden .fmde-comment-anchor{background:transparent;box-shadow:none}\n" +
    ".fmde-show-ruler .fmde-canvas:before{content:'';position:sticky;z-index:25;top:0;left:0;display:block;height:18px;background:repeating-linear-gradient(90deg,#eef1f5 0,#eef1f5 11px,#9aa0a6 12px,#eef1f5 13px,#eef1f5 47px,#5f6368 48px,#eef1f5 49px);border-bottom:1px solid #c7ccd3}\n" +
    "@media(max-width:760px){.fmde-menu-search-btn{width:32px;padding:0 8px}.fmde-menu-search-btn span{display:none}.fmde-menubar-btn{padding:0 6px}}\n";

  const EDITOR_CSS_V9 = "\n/* ---------- v9: Docs-parity tranche A ---------- */\n" +
    ".fmde-doc-border-color[hidden]{display:none!important}\n" +
    ".fmde-mode-visual .fmde-toolbar{gap:0;padding:0 7px;overflow:hidden}.fmde-mode-visual .fmde-tb-group{flex:0 0 auto;padding:0 4px;gap:1px}.fmde-mode-visual .fmde-btn{height:28px;min-width:27px;padding:0 4px}.fmde-visual-element-tools[hidden],.fmde-visual-font-tools[hidden],.fmde-visual-border-color[hidden]{display:none!important}.fmde-background-color,.fmde-border-color{display:grid!important;place-items:center;padding:0!important}.fmde-background-color-dot{display:block;width:18px;height:18px;border:1px solid rgba(17,24,39,.22);border-radius:50%;background:var(--tool-color,#fff);box-shadow:inset 0 0 0 2px rgba(255,255,255,.72)}.fmde-border-color-dot{display:block;width:18px;height:18px;border:4px solid var(--tool-color,#202124);border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgba(17,24,39,.16)}.fmde-background-color:hover .fmde-background-color-dot,.fmde-border-color:hover .fmde-border-color-dot{outline:2px solid var(--fmde-accent);outline-offset:1px}.fmde-visual-font-tools{display:flex;align-items:center;gap:1px;margin-left:3px;padding-left:4px;border-left:1px solid var(--fmde-border-soft)}.fmde-visual-font-tools .fmde-fontselect{min-width:92px;max-width:118px;justify-content:space-between}.fmde-visual-font-tools .fmde-fontsize{min-width:32px;border:1px solid var(--fmde-border);font-variant-numeric:tabular-nums}.fmde-style-menu{width:330px;padding:16px;overflow:visible}.fmde-style-menu-title{margin:12px 0 8px;font-size:13px;font-weight:700}.fmde-style-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.fmde-style-preset{height:42px;border:1px solid var(--fmde-border);border-radius:9px;background:#fff;color:#202124;cursor:pointer}.fmde-style-preset:hover,.fmde-style-preset.active{border:2px solid var(--fmde-accent);color:var(--fmde-accent)}.fmde-style-preset i{display:block;width:28px;margin:auto;border-top:var(--sample-width,2px) var(--sample-style,solid) currentColor}.fmde-style-slider-row{display:grid;grid-template-columns:1fr 52px;align-items:center;gap:12px}.fmde-style-slider-row input[type=range]{width:100%;accent-color:var(--fmde-accent)}.fmde-style-number{height:38px;width:52px;border:1px solid var(--fmde-border);border-radius:9px;text-align:center;font:inherit}.fmde-corners-icon{display:block;width:17px;height:17px;border-left:2px solid currentColor;border-top:2px solid currentColor;border-top-left-radius:var(--corner-preview,5px)}\n" +
    ".fmde-element-context{width:226px;padding:6px}.fmde-context-style-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;padding:0 0 6px;margin-bottom:4px;border-bottom:1px solid var(--fmde-border-soft,rgba(17,24,39,.08))}.fmde-context-style-btn{display:grid;place-items:center;height:36px;padding:0;border:1px solid var(--fmde-border,#dadce0);border-radius:8px;background:#fff;color:#3c4043;cursor:pointer}.fmde-context-style-btn:hover{border-color:var(--fmde-accent);background:var(--fmde-accent-soft);color:var(--fmde-accent)}.fmde-context-style-btn.mixed{filter:grayscale(1);opacity:.46;background:#f1f3f4}.fmde-context-style-btn.mixed:hover{filter:grayscale(.45);opacity:.8}.fmde-style-menu.mixed .fmde-style-slider-row,.fmde-style-menu.mixed .fmde-style-presets{filter:grayscale(1);opacity:.62}.fmde-context-style-btn svg{width:18px;height:18px}.fmde-context-style-btn .fmde-background-color-dot,.fmde-context-style-btn .fmde-border-color-dot{width:19px;height:19px}.fmde-element-context .fmde-menu-item:last-child{color:#c5221f}.fmde-element-context .fmde-menu-item:last-child .fmde-menu-ic{color:inherit}.fmde-selbox{border-color:var(--fmde-selection-color,var(--fmde-accent));box-shadow:0 0 0 calc(.75 * var(--fmde-px,1px)) var(--fmde-selection-halo,transparent)}.fmde-selbox .fmde-handle{border-color:var(--fmde-selection-color,var(--fmde-accent))}.fmde-selbox.group-member{border-style:dotted;border-width:calc(2 * var(--fmde-px,1px));opacity:.9;box-shadow:none;filter:drop-shadow(0 0 calc(.75 * var(--fmde-px,1px)) var(--fmde-selection-halo,rgba(255,255,255,.8)))}\n" +
    ".fmde-doc-object-chrome{border-color:var(--fmde-selection-color,var(--fmde-accent));box-shadow:0 0 0 1px var(--fmde-selection-halo,transparent)}.fmde-doc-object-chrome-member{border-style:dashed;box-shadow:none;filter:drop-shadow(0 0 1px var(--fmde-selection-halo,rgba(255,255,255,.8)))}.fmde-doc-object-group-member{z-index:8998;border-style:dotted;pointer-events:none;box-shadow:none;filter:drop-shadow(0 0 1px var(--fmde-selection-halo,rgba(255,255,255,.8)))}\n" +
    ".fmde-wordcount-chip{position:absolute;left:14px;bottom:14px;z-index:40;height:28px;padding:0 12px;border:1px solid var(--fmde-border,#dadce0);border-radius:14px;background:#fff;box-shadow:0 2px 8px rgba(15,23,42,.14);color:#3c4043;font:600 12px/26px inherit;cursor:pointer}.fmde-wordcount-chip:hover{background:#f8f9fa}\n" +
    ".fmde-bookmark-flag{position:absolute;z-index:30;width:16px;height:16px;padding:0;border:0;background:transparent;color:#1a73e8;cursor:pointer;opacity:.85}.fmde-bookmark-flag:hover{opacity:1}.fmde-bookmark-flag svg{width:14px;height:14px;fill:currentColor;stroke:currentColor}\n" +
    ".fmde-specialchar-list{max-height:52vh;overflow:auto;padding-right:4px}.fmde-specialchar-section h3{margin:12px 0 6px;color:#5f6368;font-size:11px;text-transform:uppercase;letter-spacing:.06em}.fmde-specialchar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(40px,1fr));gap:4px}.fmde-specialchar{display:grid;place-items:center;height:40px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;font-size:18px;cursor:pointer}.fmde-specialchar:hover{border-color:var(--fmde-accent);background:var(--fmde-accent-soft)}\n" +
    ".fmde-suggest-quote{margin:0 0 12px;padding:8px 12px;border-left:3px solid var(--fmde-accent,#2563eb);background:#f8f9fa;border-radius:0 8px 8px 0;color:#3c4043;font-size:13px;white-space:pre-wrap}.fmde-dialog textarea{border:1px solid #dadce0;border-radius:7px;padding:8px 9px;font:inherit;resize:vertical;min-height:64px}\n" +
    "::highlight(fmde-find){background:#fde293;color:inherit}::highlight(fmde-find-active){background:#f8a212;color:#111}\n" +
    ".fmde-outline-panel{position:absolute;top:8px;left:16px;bottom:16px;z-index:45;display:flex;flex-direction:column;gap:2px;width:min(240px,60vw);padding:8px;border:1px solid var(--fmde-border,#dadce0);border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.18);overflow:auto}.fmde-outline-head{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 6px;font-size:12px;font-weight:750;color:#3c4043}.fmde-outline-item{display:block;width:100%;padding:5px 8px;border:0;border-radius:7px;background:transparent;color:#3c4043;font:inherit;font-size:12px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fmde-outline-item:hover{background:#f1f3f4}.fmde-outline-empty{padding:8px;color:#80868b;font-size:11px}.fmde-outline-toggle{display:none;position:absolute;top:12px;left:12px;z-index:46;width:30px;height:30px;padding:0;border:1px solid var(--fmde-border,#dadce0);border-radius:9px;background:#fff;color:#5f6368;box-shadow:0 2px 8px rgba(15,23,42,.14);place-items:center;cursor:pointer}.fmde-mode-doc .fmde-outline-toggle{display:grid}.fmde-mode-doc .fmde-outline-toggle.active{display:none}.fmde-outline-toggle:hover{background:var(--fmde-accent-soft,#e8f0fe);color:var(--fmde-accent,#2563eb);border-color:color-mix(in srgb,var(--fmde-accent,#2563eb) 38%,#dadce0)}.fmde-outline-toggle svg{width:15px;height:15px}\n" +
    ".fmde-border-sides{display:flex;gap:14px;flex-wrap:wrap}\n" +
    ".fmde-cell-edit{cursor:text}.fmde-cell-edit:focus{outline:2px solid var(--fmde-accent,#2563eb);outline-offset:-2px}.fmde-cell-edit{white-space:pre-wrap}\n" +
    ".fmde-table-chip{position:absolute;z-index:60;display:flex;flex-wrap:wrap;gap:2px;max-width:calc(100% - 24px);padding:4px;border:1px solid var(--fmde-border,#dadce0);border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.2)}.fmde-table-chip .fmde-btn{height:26px;padding:0 8px;font-size:11px}\n" +
    ".fmde-col-resize, .fmde-col-resize td, .fmde-col-resize th{cursor:col-resize!important}\n" +
    ".fmde-footnote-del{flex:none;width:16px;height:16px;margin-left:4px;padding:0;border:0;border-radius:50%;background:transparent;color:#9aa0a6;font-size:12px;line-height:1;cursor:pointer}.fmde-footnote-del:hover{background:#fce8e6;color:#c5221f}.fmdoc-footnote-text:focus{outline:1px solid var(--fmde-accent,#2563eb);outline-offset:1px;border-radius:2px}\n" +
    ".fmde-header-chip{position:absolute;z-index:60;display:flex;gap:14px;padding:6px 10px;border:1px solid var(--fmde-border,#dadce0);border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.2);font-size:12px}\n" +
    "::highlight(fmde-spell){background:#fce8e6}::highlight(fmde-grammar){background:#e8f0fe}\n" +
    ".fmde-version-tools{display:flex;gap:8px;margin-bottom:12px}.fmde-version-tools input{flex:1;height:32px;border:1px solid #dadce0;border-radius:7px;padding:0 9px;font:inherit}.fmde-version-list{max-height:46vh;overflow:auto;display:grid;gap:6px}.fmde-version-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid #eef1f5;border-radius:9px}.fmde-version-meta{display:grid}.fmde-version-meta b{font-size:12px}.fmde-version-meta span{color:#6b7280;font-size:11px}.fmde-version-actions{display:flex;gap:4px}.fmde-version-actions .fmde-btn{height:26px;padding:0 9px;font-size:11px;background:var(--fmde-accent-soft,#e8f0fe)}\n" +
    ".fmde-diff-body{max-height:52vh;overflow:auto;display:grid;gap:8px}.fmde-diff-row{padding:8px 10px;border:1px solid #eef1f5;border-radius:8px;font-size:12px;line-height:1.5}.fmde-diff-add{background:#e6f4ea;color:#137333}.fmde-diff-del{background:#fce8e6;color:#c5221f;text-decoration:line-through}\n" +
    ".fmde-collab-cursor{position:absolute;z-index:35;width:2px;pointer-events:none}.fmde-collab-cursor-tag{position:absolute;top:-14px;left:-2px;padding:1px 5px;border-radius:4px;color:#fff;font-size:9px;font-weight:700;white-space:nowrap;pointer-events:none}\n" +
    ".fmde-spell-panel{position:absolute;top:8px;right:16px;bottom:16px;z-index:9450;display:flex;flex-direction:column;width:min(320px,calc(100vw - 32px));border:1px solid var(--fmde-border,#dadce0);border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.22)}.fmde-spell-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #f1f3f4;font-size:13px;font-weight:750}.fmde-spell-list{flex:1;overflow:auto;padding:8px}.fmde-spell-row{padding:8px;border-radius:8px;cursor:pointer}.fmde-spell-row:hover{background:#f8f9fa}.fmde-spell-row-spelling .fmde-spell-label{color:#c5221f;font-weight:700}.fmde-spell-row-grammar .fmde-spell-label{color:#1a73e8}.fmde-spell-label{font-size:12px;margin-bottom:5px}.fmde-spell-actions{display:flex;flex-wrap:wrap;gap:4px}.fmde-spell-actions .fmde-btn{height:24px;padding:0 8px;font-size:11px;background:var(--fmde-accent-soft,#e8f0fe)}.fmde-spell-actions .fmde-spell-secondary{background:transparent;color:#5f6368}\n" +
    ".fmde-show-ruler .fmde-canvas:before{content:none!important}.fmde-ruler-ui{position:sticky;top:0;left:0;z-index:26;height:18px;background:repeating-linear-gradient(90deg,#eef1f5 0,#eef1f5 11px,#9aa0a6 12px,#eef1f5 13px,#eef1f5 47px,#5f6368 48px,#eef1f5 49px);border-bottom:1px solid #c7ccd3}.fmde-ruler-handle{position:absolute;top:0;z-index:2;cursor:ew-resize;touch-action:none}.fmde-ruler-margin{width:6px;height:18px;background:#5f6368;opacity:.65}.fmde-ruler-margin:hover{opacity:1}.fmde-ruler-margin-left{margin-left:-10px}.fmde-ruler-margin-right{margin-left:4px}.fmde-ruler-first{width:0;height:0;margin-left:-5px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid var(--fmde-accent,#2563eb)}.fmde-ruler-indent{top:auto;bottom:0;width:0;height:0;margin-left:-5px;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid var(--fmde-accent,#2563eb)}\n" +
    ".fmde-img-overlay{position:absolute;z-index:55;pointer-events:none;outline:2px solid var(--fmde-accent,#2563eb);outline-offset:1px}.fmde-img-chip{position:absolute;top:-38px;left:0;display:flex;gap:2px;padding:4px;border:1px solid var(--fmde-border,#dadce0);border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.2);pointer-events:auto}.fmde-img-chip .fmde-btn{height:26px;padding:0 8px;font-size:11px}.fmde-img-handle{position:absolute;right:-6px;bottom:-6px;width:12px;height:12px;border:2px solid #fff;border-radius:50%;background:var(--fmde-accent,#2563eb);box-shadow:0 1px 4px rgba(15,23,42,.4);cursor:nwse-resize;pointer-events:auto;touch-action:none}\n" +
    ".fmde-find-panel{position:absolute;top:8px;right:16px;z-index:9500;display:grid;gap:8px;width:min(400px,calc(100vw - 32px));padding:12px;border:1px solid var(--fmde-border,#dadce0);border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.22)}.fmde-find-row{display:flex;align-items:center;gap:6px}.fmde-find-row input{flex:1;min-width:0;height:32px;border:1px solid #dadce0;border-radius:7px;padding:0 9px;font:inherit;outline:none}.fmde-find-row input:focus{border-color:var(--fmde-accent)}.fmde-find-count{color:#5f6368;font-size:11px;white-space:nowrap}.fmde-find-case{display:flex;align-items:center;gap:7px;color:#3c4043;font-size:12px}.fmde-find-case input{width:14px;height:14px}\n";

  const EDITOR_CSS_V10 = "\n/* ---------- v10: shared table tools ---------- */\n" +
    ".fmde-profile-website .fmde-stage .fmdoc-view{background:transparent!important;box-shadow:none!important;border-radius:0!important;overflow:visible!important}\n" +
    ".fmde-tb-host-actions{gap:8px!important;padding-inline:18px!important;margin-inline:8px}.fmde-device-seg .fmde-modebtn{display:grid;place-items:center;width:28px;min-width:28px;padding:0}.fmde-web-controls{width:32px;min-width:32px!important;padding:0!important}.fmde-host-publish{padding:0 16px!important;background:var(--fmde-accent)!important;color:var(--fmde-on-accent)!important}.fmde-host-publish:hover:not(:disabled){filter:brightness(.96)}.fmde-tb-host-actions+.fmde-tb-version{margin-left:8px;padding-left:14px!important}\n" +
    ".fmde-site-chrome-control{display:flex;align-items:center;height:30px;border:1px solid var(--fmde-border);border-radius:7px;background:#fff;overflow:hidden}.fmde-site-chrome-control>i{display:grid;place-items:center;width:24px;color:var(--fmde-muted);font-size:11px}.fmde-site-chrome-select{width:92px;height:28px;min-width:0;padding:0 20px 0 2px;border:0;background:transparent;color:var(--fmde-text);font:600 11px Montserrat,Inter,ui-sans-serif,sans-serif;outline:0;text-overflow:ellipsis}.fmde-site-chrome-eye{width:28px;min-width:28px!important;height:28px!important;border-left:1px solid var(--fmde-border-soft)!important;border-radius:0!important;color:var(--fmde-muted)!important}.fmde-site-chrome-eye.active{background:var(--fmde-accent-soft)!important;color:var(--fmde-accent)!important}\n" +
    ".fmde-table-picker-menu{width:auto;max-width:min(470px,calc(100vw - 16px));overflow:auto}.fmde-table-picker{display:grid;gap:8px;padding:7px}.fmde-table-picker-grid{display:grid;gap:3px}.fmde-table-picker-cell{width:19px;height:19px;padding:0;border:1px solid #cfd5dd;border-radius:2px;background:#fff;cursor:pointer}.fmde-table-picker-cell.active{border-color:var(--fmde-accent);background:var(--fmde-accent-soft)}.fmde-table-picker-label{text-align:center;color:#3c4043;font-size:12px;font-weight:700}\n" +
    ".fmde-table-context{min-width:246px}.fmde-table-context .fmde-menu-item:last-child{color:#c5221f}\n" +
    ".fmde-mode-doc.fmde-table-tools:not(.fmde-insp-collapsed) .fmde-inspector{display:flex;flex-direction:column;padding:0}.fmde-mode-doc.fmde-table-tools .fmde-insp-inspect{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 10px}.fmde-mode-doc.fmde-table-tools .fmde-insp-collapse{display:inline-flex}\n" +
    ".fmde-mode-doc .fmdoc-page,.fmde-mode-visual .fmdoc-page{overflow:visible!important}.fmde-mode-doc .fmdoc-page-content,.fmde-mode-visual .fmdoc-page-content{z-index:auto}.fmde-mode-doc .fmdoc-node.fmde-doc-object-dragging{z-index:2147483000!important;opacity:.9}\n";
  const EDITOR_CSS_V11 = "\n/* ---------- v11: responsive website item placement ---------- */\n" +
    ".fmde-context-responsive{display:grid;gap:6px;padding:0 0 7px;margin-bottom:4px;border-bottom:1px solid var(--fmde-border-soft,rgba(17,24,39,.08))}.fmde-context-responsive-row{display:grid;gap:5px}.fmde-context-responsive-mode{grid-template-columns:repeat(2,minmax(0,1fr))}.fmde-context-position-row{grid-template-columns:repeat(3,minmax(0,1fr))}.fmde-context-responsive-choice{grid-template-columns:repeat(2,minmax(0,1fr))}.fmde-context-responsive-manual{display:grid;gap:6px}.fmde-context-responsive-manual[hidden]{display:none}.fmde-context-responsive-label{color:var(--fmde-muted,#5f6368);font:700 9px Montserrat,Inter,sans-serif;letter-spacing:.035em;text-transform:uppercase}.fmde-context-position-btn{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;height:34px;padding:0 7px;border:1px solid var(--fmde-border,#dadce0);border-radius:8px;background:#fff;color:#5f6368;cursor:pointer;font:700 10px Montserrat,Inter,sans-serif;white-space:nowrap}.fmde-context-position-btn:hover,.fmde-context-position-btn.active{border-color:var(--fmde-accent);background:var(--fmde-accent-soft);color:var(--fmde-accent)}.fmde-context-position-btn.mixed{filter:grayscale(1);opacity:.46}.fmde-context-position-btn i{font-size:15px}.fmde-context-position-unit{letter-spacing:.02em}\n" +
    ".fmde-guide-gap{height:calc(1 * var(--fmde-px,1px));transform:translateY(-50%)}.fmde-guide-gap:before,.fmde-guide-gap:after{content:'';position:absolute;top:50%;width:calc(1 * var(--fmde-px,1px));height:calc(7 * var(--fmde-px,1px));background:var(--fmde-guide);transform:translateY(-50%)}.fmde-guide-gap:before{left:0}.fmde-guide-gap:after{right:0}.fmde-doc-guide-gap{height:1px;transform:translateY(-50%)}.fmde-doc-guide-gap:before,.fmde-doc-guide-gap:after{content:'';position:absolute;top:50%;width:1px;height:7px;background:var(--fmde-guide);transform:translateY(-50%)}.fmde-doc-guide-gap:before{left:0}.fmde-doc-guide-gap:after{right:0}\n";

  const EDITOR_CSS_V12 = "\n/* ---------- v12: selectable structural tabs ---------- */\n" +
    ".fmde-mode-doc .fmde-docedit .fmdoc-indent-marker{display:inline-block;width:18pt;white-space:pre}\n";

  function ensureEditorStyles(doc) {
    if (!doc || !doc.head || doc.getElementById(EDITOR_STYLE_ELEMENT_ID)) return;
    const style = doc.createElement("style");
    style.id = EDITOR_STYLE_ELEMENT_ID;
    style.textContent = EDITOR_CSS + EDITOR_CSS_V3 + EDITOR_CSS_V5 + EDITOR_CSS_V6 + EDITOR_CSS_V7 + EDITOR_CSS_V8 + EDITOR_CSS_V9 + EDITOR_CSS_V10 + EDITOR_CSS_V11 + EDITOR_CSS_V12;
    doc.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Editor mount
  // ---------------------------------------------------------------------------

  function mount(container, opts) {
    if (!container || !container.appendChild) throw new Error("FMDocEditor.mount: container element required");
    ensureEditorStyles(container.ownerDocument || (typeof document !== "undefined" ? document : null));
    opts = opts || {};
    const M = (root && root.FMDocModel) || (typeof FMDocModel !== "undefined" ? FMDocModel : null);
    if (!M) throw new Error("FMDocEditor requires FMDocModel — load doc-model/firstmate-doc-model.js first");
    const renderer = (root && root.FMDocRenderer) || (typeof FMDocRenderer !== "undefined" ? FMDocRenderer : null);
    if (!renderer) throw new Error("FMDocEditor requires window.FMDocRenderer — load doc-renderer/firstmate-doc-renderer.js first");

    // ---- state ---------------------------------------------------------------

    const state = {
      doc: opts.document ? M.deepClone(opts.document) : M.createDocument({}),
      widgetData: opts.widgetData || null,
      profile: "document",
      baseProfile: "document",
      // Mode = interaction surface over the same command bus/undo stack.
      // "visual" (designer boxes), "doc" (word processor), "preview" (static).
      mode: MODES.indexOf(opts.mode) !== -1 ? opts.mode : "visual",
      renderToken: 0,
      flags: {},
      policy: null,
      selection: [],
      selectedPageId: null,
      currentPageId: null,
      enterFrameId: null,
      zoom: 1,
      // Hosts such as the mobile-device preview can temporarily own zoom.
      // While locked, toolbar, keyboard and wheel zoom all resolve to this
      // single value instead of creating a second scale inside the host.
      zoomLock: null,
      fitMode: null,
      // View docs only: pixel-width constraint for mobile preview
      // (opts.viewportWidth / editor.setViewportWidth — contracts §10).
      viewportWidth: null,
      // opts.dataPreview seeds the "Data preview" toolbar toggle (default off,
      // preserving prior behavior); it only matters when resolveScope is given.
      dataPreview: opts && opts.dataPreview === true,
      spellcheck: true,
      paintFormat: null,
      typingFormat: { family: "", size_pt: null, color: "#202124", background: "transparent", bold: null, italic: null, underline: null, strikeThrough: null, superscript: null, subscript: null },
      commentDraft: null,
      commentsVisible: true,
      printLayout: true,
      showNonPrinting: false,
      showRuler: false,
      wordCountLive: false,
      showOutline: false,
      tableFocus: null,
      imageFocus: null,
      docKeyboardObjectId: null,
      pendingInsert: null,
      textEditing: null,
      cropSession: null,
      clipboard: null,
      pasteCount: 0,
      previewOutputs: {},
      renderHandle: null,
      renderError: null,
      pageEntries: [],
      nodeIndex: new Map(),
      selBoxes: new Map(),
      dirty: false,
      dictating: false,
      destroyed: false,
      suppressInspector: false,
      activeRailTab: "pages",
      railCollapsed: false,
      inspectorCollapsed: false,
      inspectorAutoOpened: false,
      inspectorSectionOpen: new Map(),
      viewNormalizeTried: false,
      // Host-provided right-tray panels ({id, label, icon?, render(hostEl)}):
      // the inspector becomes a tabbed tray (Inspect + panels). Panel DOM is
      // rendered once and shown/hidden by tab so stateful content (an agent
      // chat scrollback, a data form) survives inspector re-renders.
      sidePanels: [],
      activeInspTab: "inspect",
      sidePanelEls: new Map(),
      colorUsage: {}
    };
    try {
      state.railCollapsed = (root.localStorage && root.localStorage.getItem("fmde_rail_collapsed")) === "1";
      state.inspectorCollapsed = (root.localStorage && root.localStorage.getItem("fmde_insp_collapsed")) === "1";
      state.colorUsage = JSON.parse((root.localStorage && root.localStorage.getItem("fmde_color_usage_v1")) || "{}") || {};
    } catch (e) { /* private mode */ }
    state.sidePanels = Array.isArray(opts.sidePanels)
      ? opts.sidePanels.filter(function (p) { return p && p.id && typeof p.render === "function"; })
      : [];
    if (state.sidePanels.length && opts.initialSidePanel) state.activeInspTab = String(opts.initialSidePanel);

    const dims = function () { return M.paperDimensions(state.doc); };
    const isViewDoc = function () { return state.doc && state.doc.kind === "view"; };
    if (isViewDoc() && typeof M.normalizeViewHorizontalPositions === "function") {
      M.normalizeViewHorizontalPositions(state.doc, { default_responsive_mode: opts.viewResponsiveDefault });
    }
    if (isViewDoc() && Number(opts.viewportWidth) > 0) state.viewportWidth = Number(opts.viewportWidth);

    /** Effective design width for view docs: the root frame may be wider than
     *  settings.paper (site pages carry their design width on the root). */
    function viewDesignWidthPt() {
      const paper = dims();
      if (!isViewDoc()) return paper.w_pt;
      const rootW = state.doc.root && state.doc.root.frame && state.doc.root.frame.w;
      return Number(rootW) > 0 ? Number(rootW) : paper.w_pt;
    }

    function viewIsFill() {
      return isViewDoc() && !!dims().fill;
    }

    const listeners = {};
    function on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return function () {
        const list = listeners[event] || [];
        const at = list.indexOf(fn);
        if (at !== -1) list.splice(at, 1);
      };
    }
    function emit(event) {
      const args = Array.prototype.slice.call(arguments, 1);
      for (const fn of (listeners[event] || []).slice()) {
        try { fn.apply(null, args); } catch (err) { if (root && root.console) root.console.error("[FMDocEditor] listener error", err); }
      }
    }

    // ---- edit policy + feature flags ------------------------------------------

    function combineFeature(a, b) {
      if (a === false || b === false) return false;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter(function (id) { return b.indexOf(id) !== -1; });
      if (Array.isArray(a)) return a;
      if (Array.isArray(b)) return b;
      if (a === undefined && b === undefined) return undefined;
      return true;
    }

    function computePolicy() {
      const docPol = (state.doc && state.doc.edit_policy) || {};
      const optPol = opts.editPolicy || {};
      const features = {};
      const keys = {};
      for (const k of Object.keys(docPol.features || {})) keys[k] = true;
      for (const k of Object.keys(optPol.features || {})) keys[k] = true;
      for (const k of Object.keys(keys)) features[k] = combineFeature((docPol.features || {})[k], (optPol.features || {})[k]);
      const ranks = [docPol.max_profile, optPol.max_profile].filter(function (p) { return PROFILE_RANK[p] !== undefined; });
      let maxProfile = "designer";
      for (const p of ranks) if (PROFILE_RANK[p] < PROFILE_RANK[maxProfile]) maxProfile = p;
      const unlockAllowed = (!docPol.unlock || docPol.unlock.allowed !== false) && (!optPol.unlock || optPol.unlock.allowed !== false);
      return {
        features: features,
        base_profile: optPol.base_profile || docPol.base_profile || null,
        max_profile: maxProfile,
        unlock: {
          allowed: unlockAllowed,
          permission: (optPol.unlock && optPol.unlock.permission) || (docPol.unlock && docPol.unlock.permission) || null
        }
      };
    }

    function computeFlags(profile) {
      const base = PROFILE_FLAGS[profile] || PROFILE_FLAGS.document;
      const flags = {};
      for (const key of FEATURE_KEYS) {
        const preset = base[key];
        const pol = state.policy.features[key];
        if (!preset) { flags[key] = false; continue; }
        if (pol === undefined) { flags[key] = preset; continue; }
        if (pol === false) { flags[key] = false; continue; }
        if (Array.isArray(pol)) { flags[key] = pol.slice(); continue; }
        flags[key] = preset;
      }
      // Grouping is part of free transformation, not an optional widget/type
      // capability. If an object can be moved, any multi-selection of such
      // objects can be grouped; hosts that need to forbid grouping must lock
      // movement itself (globally or per node), avoiding movable-but-
      // mysteriously-ungroupable blocks.
      if (flags.free_transform) flags.group = true;
      if (state.policy.unlock.allowed === false) flags.unlock = false;
      return flags;
    }

    function can(feature) {
      const value = state.flags[feature];
      return Array.isArray(value) ? value.length > 0 : !!value;
    }

    function widgetInsertAllowed(widgetId) {
      const value = state.flags.widget_insert;
      if (value === true) return true;
      if (Array.isArray(value)) return value.indexOf(widgetId) !== -1;
      return false;
    }

    function lockBlocked(node, key) {
      return engine.lockBlocked(node, key);
    }

    // ---- command engine ---------------------------------------------------------

    let pendingChangeCommands = [];
    const flushChange = debounce(function () {
      if (state.destroyed) return;
      const meta = { commands: pendingChangeCommands.slice() };
      pendingChangeCommands = [];
      const docCopy = M.deepClone(state.doc);
      emit("change", docCopy, meta);
      if (typeof opts.onChange === "function") {
        try { opts.onChange(docCopy, meta); } catch (err) { if (root && root.console) root.console.error("[FMDocEditor] onChange error", err); }
      }
    }, CHANGE_DEBOUNCE_MS);

    const engine = createCommandEngine({
      M: M,
      getDoc: function () { return state.doc; },
      getFlags: function () { return state.flags; },
      getProfile: function () { return state.profile; },
      onApplied: onEngineApplied
    });

    function onEngineApplied(entry, origin) {
      // Responsive placement is a view-document invariant, including nodes
      // synthesized by structural commands such as group/ungroup and by host
      // command callers. Keep it centralized at the command boundary so no
      // insertion path can accidentally create a legacy absolute-only item.
      if (isViewDoc() && typeof M.normalizeViewHorizontalPositions === "function") {
        M.normalizeViewHorizontalPositions(state.doc, {
          parent_width_pt: viewDesignWidthPt(),
          default_responsive_mode: opts.viewResponsiveDefault
        });
      }
      if (!state.dirty) {
        state.dirty = true;
        emit("dirty", true);
      }
      const commands = origin === "undo" ? entry.inverse : entry.commands;
      for (const cmd of commands) pendingChangeCommands.push(cmd);
      if (origin === "apply" && typeof opts.onCommand === "function") {
        for (const cmd of entry.commands) {
          try { opts.onCommand(cmd); } catch (err) { if (root && root.console) root.console.error("[FMDocEditor] onCommand error", err); }
        }
      }
      pruneSelection();
      renderCanvas();
      refreshChrome();
      updateWordCountChip();
      if (state.showOutline) renderOutlinePanel();
      if (state.collabSession && !state.collabApplying) pushCollabCommands(commands.slice());
      flushChange();
    }

    /** Apply commands through the bus; surface rejection feedback in the UI. */
    function runCommands(commands, label) {
      // Doc mode keeps uncommitted DOM edits between keystrokes — they must
      // land in the log BEFORE any other command so ordering/undo stay sane.
      if (String(label || "").indexOf("doc:") !== 0) docProjection.commitNow("flush");
      const result = engine.apply(commands, { label: label });
      if (!result.ok) flashReason(result.reason);
      return result;
    }

    /**
     * Every in-place canvas render keeps the viewport stable. Render updates
     * briefly remove/reflow the page stack, which lets the browser clamp a
     * scrolled canvas to zero. This belongs at the render boundary rather than
     * in a list of command labels: public apply callers, undo/redo, remote
     * changes, inspector controls and refreshes all use the same guarantee.
     */
    function preserveCanvasScrollForRender() {
      if (state.pendingCanvasScrollRestore || !dom.canvas || !state.renderHandle) return;
      state.pendingCanvasScrollRestore = { left: dom.canvas.scrollLeft, top: dom.canvas.scrollTop };
    }

    /** Explicit navigation is allowed to move the viewport after a render. */
    function allowExplicitCanvasScroll() {
      state.pendingCanvasScrollRestore = null;
    }

    function restorePendingCanvasScroll(finalRestore) {
      const saved = state.pendingCanvasScrollRestore;
      if (!saved || !dom.canvas) return;
      dom.canvas.scrollLeft = saved.left;
      dom.canvas.scrollTop = saved.top;
      if (finalRestore) state.pendingCanvasScrollRestore = null;
    }

    /** Undo/redo entry points — flush pending doc-mode edits first. */
    function performUndo() {
      if (state.textEditing) commitTextEdit();
      docProjection.commitNow("flush");
      docProjection.caretToAffectedBlock();
      return engine.undo();
    }
    function performRedo() {
      if (state.textEditing) commitTextEdit();
      docProjection.commitNow("flush");
      docProjection.caretToAffectedBlock();
      return engine.redo();
    }

    function flashReason(reason) {
      if (!reason || !dom.hint) return;
      dom.hint.textContent = reasonText(reason);
      dom.hint.classList.add("show", "warn");
      clearTimeout(flashReason._timer);
      flashReason._timer = setTimeout(function () {
        dom.hint.classList.remove("show", "warn");
      }, 1800);
    }

    function reasonText(reason) {
      const r = String(reason || "");
      if (r.indexOf("locked:") === 0) return "That element is locked (" + r.slice(7) + ")";
      if (r.indexOf("feature_disabled:") === 0) return "Not available in this mode (" + r.slice(17) + ")";
      if (r === "profile_readonly") return "This document is fill-only";
      if (r === "last_page") return "A document needs at least one page";
      return "Action not allowed (" + r + ")";
    }

    function showStatus(text, warn, duration) {
      if (!dom.hint) return;
      dom.hint.textContent = String(text || "");
      dom.hint.classList.toggle("warn", !!warn);
      dom.hint.classList.add("show");
      clearTimeout(showStatus._timer);
      if (duration !== 0) {
        showStatus._timer = setTimeout(function () {
          dom.hint.classList.remove("show", "warn");
        }, Number(duration) || 1800);
      }
    }

    // ---- DOM chrome ----------------------------------------------------------------

    const dom = {};

    function editorBrandingPalette() {
      const context = isObj(opts.themeContext) ? opts.themeContext : {};
      const branding = isObj(context.branding) ? context.branding : {};
      const colors = isObj(branding.colors) ? branding.colors : {};
      const overrides = isObj(context.overrides) ? context.overrides : {};
      let inherited = "";
      try {
        const computed = root.getComputedStyle(document.documentElement);
        inherited = computed.getPropertyValue("--fm-primary").trim() ||
          computed.getPropertyValue("--primary-readable").trim() ||
          computed.getPropertyValue("--primary").trim();
      } catch (e) { /* detached/test documents use the explicit branding context */ }
      const candidates = [
        colors.primary, branding.primary, colors.brand, branding.brand,
        colors.accent, branding.accent, inherited, overrides["--fm-primary"],
        "#2563eb"
      ];
      let primary = null;
      for (const candidate of candidates) {
        primary = parseCssColor(candidate);
        if (primary) break;
      }
      const lightText = parseCssColor("#ffffff");
      const darkText = parseCssColor("#111827");
      const foreground = contrastRatio(primary, darkText) >= contrastRatio(primary, lightText) ? darkText.css : lightText.css;
      return {
        primary: primary.css,
        foreground: foreground,
        soft: "rgba(" + primary.r + ", " + primary.g + ", " + primary.b + ", 0.12)"
      };
    }

    function applyEditorBranding(node) {
      if (!node || !node.style) return node;
      const palette = editorBrandingPalette();
      node.style.setProperty("--fmde-accent", palette.primary);
      node.style.setProperty("--fmde-accent-soft", palette.soft);
      node.style.setProperty("--fmde-on-accent", palette.foreground);
      return node;
    }

    function buildChrome() {
      // data-fmde marks the editor canvas for the renderer's link-click guard
      // (linked nodes render as anchors; inside an editor they select, never
      // navigate).
      dom.root = applyEditorBranding(el("div", { class: "fmde-root", tabindex: "0", "data-fmde": "editor" }));
      dom.menubar = el("nav", { class: "fmde-menubar", "aria-label": "Document menus" });
      dom.toolbar = el("div", { class: "fmde-toolbar", role: "toolbar" });
      dom.body = el("div", { class: "fmde-body" });
      dom.rail = el("div", { class: "fmde-rail" });
      dom.railTabs = el("div", { class: "fmde-rail-tabs" });
      dom.railBody = el("div", { class: "fmde-rail-body" });
      dom.rail.appendChild(dom.railTabs);
      dom.rail.appendChild(dom.railBody);
      dom.canvas = el("div", { class: "fmde-canvas" });
      dom.stage = el("div", { class: "fmde-stage" });
      dom.hint = el("div", { class: "fmde-hint" });
      dom.popover = el("div", { class: "fmde-popover", hidden: true });
      dom.canvas.appendChild(dom.stage);
      dom.canvas.appendChild(dom.hint);
      dom.canvas.appendChild(dom.popover);
      dom.outlineToggle = el("button", { type: "button", class: "fmde-outline-toggle", title: (globalThis.PlatformLanguage?.text("doc-editor","m_8d4d587ae8e3bc","Show document outline") ?? "Show document outline"), "aria-label": "Show document outline", "aria-expanded": "false", html: iconSvg("chevright") });
      dom.outlineToggle.addEventListener("click", function () {
        state.showOutline = !state.showOutline;
        renderOutlinePanel();
      });
      dom.inspector = el("div", { class: "fmde-inspector" });
      // Tabbed right tray: a tab strip (hidden without host panels), the
      // Inspect body (the classic inspector content), and one lazily-rendered
      // host element per side panel.
      dom.inspTabs = el("div", { class: "fmde-insp-tabs", hidden: true });
      dom.inspBody = el("div", { class: "fmde-insp-inspect" });
      dom.inspPanels = el("div", { class: "fmde-insp-panels", hidden: true });
      dom.inspector.appendChild(dom.inspTabs);
      dom.inspector.appendChild(dom.inspBody);
      dom.inspector.appendChild(dom.inspPanels);
      // Collapsible side panels: slim expand strips replace a collapsed panel
      // (state persists across mounts via localStorage — a workspace pref).
      dom.railExpand = el("button", { type: "button", class: "fmde-side-expand fmde-side-expand-left", title: (globalThis.PlatformLanguage?.text("doc-editor","m_5ac45739e6a507","Show panel") ?? "Show panel"), html: iconSvg("chevright") });
      dom.railExpand.addEventListener("click", function () { setSideCollapsed("rail", false); });
      dom.inspExpand = el("button", { type: "button", class: "fmde-side-expand fmde-side-expand-right", title: (globalThis.PlatformLanguage?.text("doc-editor","m_5ac45739e6a507","Show panel") ?? "Show panel"), html: iconSvg("chevleft") });
      dom.inspExpand.addEventListener("click", function () { setSideCollapsed("inspector", false); });
      dom.inspCollapse = el("button", { type: "button", class: "fmde-insp-collapse", title: (globalThis.PlatformLanguage?.text("doc-editor","m_80936f789d4bde","Collapse panel") ?? "Collapse panel"), html: iconSvg("chevright") });
      dom.inspCollapse.addEventListener("click", function () { setSideCollapsed("inspector", true); });
      dom.body.appendChild(dom.rail);
      dom.body.appendChild(dom.railExpand);
      dom.body.appendChild(dom.canvas);
      dom.body.appendChild(dom.outlineToggle);
      dom.body.appendChild(dom.inspector);
      dom.body.appendChild(dom.inspExpand);
      dom.body.appendChild(dom.inspCollapse);
      dom.root.appendChild(dom.menubar);
      dom.root.appendChild(dom.toolbar);
      dom.root.appendChild(dom.body);
      container.appendChild(dom.root);

      dom.root.addEventListener("keydown", onKeyDown);
      dom.toolbar.addEventListener("pointerdown", function (ev) {
        // Doc toolbar controls operate on the current caret/selection. Keeping
        // focus in the contenteditable also keeps the insertion caret visible.
        if (state.mode === "doc" && ev.target.closest("button") && !ev.target.closest("input,select,textarea")) ev.preventDefault();
      });
      dom.menubar.addEventListener("pointerdown", function (ev) {
        if (state.mode === "doc" && ev.target.closest("button")) ev.preventDefault();
      });
      dom.canvas.addEventListener("wheel", onCanvasWheel, { passive: false });
      dom.canvas.addEventListener("scroll", function () { positionViewRootSelection(); }, { passive: true });
      // Doc-mode projection listeners are delegated so they survive re-renders.
      dom.stage.addEventListener("beforeinput", function (ev) { docProjection.onBeforeInput(ev); });
      dom.stage.addEventListener("input", function (ev) { docProjection.onInput(ev); });
      dom.stage.addEventListener("focusout", function (ev) { docProjection.onFocusOut(ev); });
      // Internal links (#fmdoc-block:… / #fmdoc-bookmark:…) scroll in-document
      // instead of navigating; contenteditable swallows normal clicks anyway,
      // so this also makes them work at all while editing.
      dom.stage.addEventListener("click", function (ev) {
        const anchor = ev.target && ev.target.closest ? ev.target.closest('a[href^="#fmdoc-"]') : null;
        if (!anchor) return;
        ev.preventDefault();
        followInternalLink(anchor.getAttribute("href") || "");
      });
      // Table chip follows cell focus; leaves when focus moves off the table.
      dom.stage.addEventListener("focusin", function (ev) {
        if (state.mode !== "doc") return;
        const cellHit = docProjection.tableCellFrom(ev.target);
        if (cellHit && cellHit.nodeId) showTableChip(cellHit);
        else if (!(ev.target.closest && ev.target.closest(".fmde-table-chip"))) hideTableChip();
        const regionEl = ev.target.closest && ev.target.closest('[data-page-region="header"], [data-page-region="footer"], [data-page-region$="_first"], [data-page-region$="_even"]');
        if (regionEl && !regionEl.hasAttribute("data-chrome")) showHeaderOptionsChip(regionEl);
        else if (!(ev.target.closest && ev.target.closest(".fmde-header-chip"))) hideHeaderOptionsChip();
      });
      bindTableResize();
      // Image selection: click an image to get resize/wrap controls.
      dom.stage.addEventListener("click", function (ev) {
        if (state.mode !== "doc") return;
        const imgEl = ev.target && ev.target.closest ? ev.target.closest('[data-node-type="image"][data-node-id]') : null;
        const imgInfo = imgEl ? state.nodeIndex.get(rawNodeId(imgEl.getAttribute("data-node-id") || "")) : null;
        // Visual-inserted images are page objects and use the shared object
        // chrome below; flow images keep the word-processor image controls.
        if (imgEl && !(imgInfo && imgInfo.node && imgInfo.node.anchor === "page")) { ev.preventDefault(); selectDocImage(imgEl); }
        else if (!(ev.target.closest && ev.target.closest(".fmde-img-overlay"))) clearDocImageSelection();
        // Footnote marker ↔ strip navigation.
        const marker = ev.target && ev.target.closest ? ev.target.closest(".fmdoc-footnote-ref[data-footnote-id]") : null;
        if (marker) {
          const noteText = dom.stage.querySelector('.fmdoc-footnote-text[data-footnote-id="' + String(marker.getAttribute("data-footnote-id")).replace(/"/g, '\\"') + '"]');
          if (noteText) { allowExplicitCanvasScroll(); noteText.scrollIntoView({ block: "center", behavior: "smooth" }); noteText.focus({ preventScroll: true }); }
        }
        const noteNum = ev.target && ev.target.closest ? ev.target.closest(".fmdoc-footnote-num") : null;
        if (noteNum) {
          const row = noteNum.closest(".fmdoc-footnote");
          const ref = row && dom.stage.querySelector('.fmdoc-footnote-ref[data-footnote-id="' + String(row.getAttribute("data-footnote-id")).replace(/"/g, '\\"') + '"]');
          if (ref) { allowExplicitCanvasScroll(); ref.scrollIntoView({ block: "center", behavior: "smooth" }); }
        }
      });
      // Doc mode has no permanent page interaction overlay, so crop entry is
      // delegated from the rendered node itself. The crop session creates a
      // temporary page overlay using the same geometry and gestures as Visual.
      dom.stage.addEventListener("dblclick", function (ev) {
        if (state.mode !== "doc" || state.cropSession) return;
        const nodeEl = ev.target && ev.target.closest ? ev.target.closest('[data-node-id][data-node-type]') : null;
        if (startDocCropFromElement(nodeEl, ev)) return;
        const emptyNodeId = nodeEl && rawNodeId(nodeEl.getAttribute("data-node-id") || "");
        const emptyInfo = emptyNodeId && state.nodeIndex.get(emptyNodeId);
        if (emptyInfo && emptyInfo.node && emptyInfo.node.type === "image" && !cropMediaRef(emptyInfo.node)) {
          chooseMediaForImage(emptyNodeId, ev);
          return;
        }
        const pageEl = ev.target && ev.target.closest ? ev.target.closest('.fmdoc-page[data-page-id]') : null;
        const pageId = pageEl && rawNodeId(pageEl.getAttribute("data-page-id") || "");
        if (pageEl && pageId && pageCroppable((M.findPage(state.doc, pageId) || {}).page)) {
          ev.preventDefault();
          ev.stopPropagation();
          startPageCropSession(pageId, pageEl);
        }
      });
      dom.stage.addEventListener("contextmenu", function (ev) {
        if (state.cropSession) return;
        const tableCell = ev.target && ev.target.closest ? ev.target.closest("td[data-cell], th[data-cell]") : null;
        const tableHit = tableCell && docProjection.tableCellFrom(tableCell);
        if (tableHit && tableHit.nodeId) {
          ev.preventDefault();
          ev.stopPropagation();
          setSelection([tableHit.nodeId], { keepInspector: true });
          showTableCellContextMenu(tableHit, ev.clientX, ev.clientY);
          return;
        }
        if (state.mode !== "doc") return;
        const nodeEl = ev.target && ev.target.closest ? ev.target.closest('[data-node-id][data-node-type]') : null;
        if (!nodeEl || nodeEl.getAttribute("data-chrome") === "true") {
          const pageEl = ev.target && ev.target.closest ? ev.target.closest('.fmdoc-page[data-page-id]') : null;
          const pageId = pageEl && rawNodeId(pageEl.getAttribute("data-page-id") || "");
          if (pageEl && pageId && M.findPage(state.doc, pageId)) {
            ev.preventDefault();
            ev.stopPropagation();
            showPageContextMenu(pageId, ev.clientX, ev.clientY, pageEl);
          }
          return;
        }
        const sourceNodeId = rawNodeId((nodeEl.getAttribute("data-node-id") || "").replace(/::part\d+$/, ""));
        if (!state.nodeIndex.has(sourceNodeId)) return;
        const nodeId = groupAncestorId(sourceNodeId) || sourceNodeId;
        ev.preventDefault();
        ev.stopPropagation();
        if (state.selection.indexOf(nodeId) === -1) setSelection([nodeId]);
        showElementContextMenu(nodeId, ev.clientX, ev.clientY, nodeEl, sourceNodeId);
      });
      dom.stage.addEventListener("pointerdown", function (ev) {
        if (state.mode !== "doc" || !state.cropSession) return;
        if (ev.target.closest && ev.target.closest(".fmde-cropui")) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        commitCropSession();
      }, true);
      dom.stage.addEventListener("pointerdown", function (ev) {
        if (state.mode !== "doc") return;
        // Object selection is separate from the browser's text selection.
        // Moving the caret or clicking another document surface must retire
        // the old object chrome immediately; otherwise a widget can look
        // selected while the user is actively typing somewhere else.
        const renderedHit = ev.target.closest && ev.target.closest('[data-node-id][data-node-type]');
        const renderedInfo = renderedHit ? state.nodeIndex.get(rawNodeId(renderedHit.getAttribute("data-node-id") || "")) : null;
        const objectHit = (ev.target.closest && ev.target.closest('.fmde-doc-object,.fmde-doc-object-chrome,.fmde-img-overlay,.fmde-cropui')) ||
          !!(renderedInfo && isDocModeObject(renderedInfo.node));
        if (!objectHit) clearDocObjectSelectionForText();
      }, true);
      dom.stage.addEventListener("pointerdown", function (ev) {
        if (state.mode !== "doc") return;
        if (ev.target.closest && ev.target.closest("[data-page-region]")) {
          dom.root.classList.remove("fmde-caret-passive");
          return;
        }
        if (ev.target.closest && ev.target.closest(".fmdoc-page")) {
          ev.preventDefault();
          dom.root.classList.add("fmde-caret-passive");
          docProjection.restoreLastCaret(true);
        }
      });
      dom.canvas.addEventListener("pointerdown", function (ev) {
        // Click on the gray canvas outside any page: clear selection.
        if (ev.target === dom.canvas || ev.target === dom.stage) {
          if (state.mode === "doc") {
            ev.preventDefault();
            dom.root.classList.add("fmde-caret-passive");
            docProjection.restoreLastCaret(true);
          }
          if (state.cropSession) { commitCropSession(); return; }
          if (state.pendingInsert) cancelPendingInsert();
          setSelection([]);
          state.selectedPageId = null;
          state.enterFrameId = null;
          renderInspector();
        }
      });
    }

    // ---- profile -------------------------------------------------------------------

    function applyProfile(profile) {
      const next = PROFILE_FLAGS[profile] ? profile : "document";
      docProjection.commitNow("profile-switch");
      state.profile = next;
      state.flags = computeFlags(next);
      if (state.pendingInsert) cancelPendingInsert();
      if (state.textEditing) commitTextEdit();
      // Mode availability respects the profile (fill/inline stay visual).
      if (modesAvailable().indexOf(state.mode) === -1) {
        docProjection.reset();
        state.mode = "visual";
        emit("mode", state.mode);
      }
      updateRootClass();
      buildToolbar();
      renderRail();
      renderInspector();
      syncOverlays();
      emit("profile", next);
    }

    // ---- mode system (contract §9: surfaces over the same bus/undo/policy) ----

    function updateRootClass() {
      const previewAgent = state.sidePanels.some(function (panel) { return String(panel.id) === "agent"; });
      dom.root.className = "fmde-root fmde-profile-" + state.profile +
        " fmde-mode-" + state.mode +
        (state.profile === "inline" ? " fmde-chromeless" : "") +
        (state.profile === "fill" ? " fmde-minimal" : "") +
        (state.sidePanels.length ? " fmde-has-panels" : "") +
        (previewAgent ? " fmde-preview-agent" : "") +
        (state.commentsVisible ? "" : " fmde-comments-hidden") +
        (state.printLayout ? "" : " fmde-print-layout-off") +
        (state.showNonPrinting ? " fmde-show-nonprinting" : "") +
        (state.showRuler ? " fmde-show-ruler" : "") +
        (state.railCollapsed ? " fmde-rail-collapsed" : "") +
        (state.inspectorCollapsed ? " fmde-insp-collapsed" : "");
    }

    function sidePanelPref(key) {
      try { return (root.localStorage && root.localStorage.getItem(key)) === "1"; } catch (e) { return false; }
    }

    function setSideCollapsed(which, collapsed, options) {
      options = options || {};
      const key = which === "rail" ? "railCollapsed" : "inspectorCollapsed";
      if (state[key] === !!collapsed) return;
      state[key] = !!collapsed;
      if (which === "inspector" && !options.automatic) state.inspectorAutoOpened = false;
      if (options.temporary) {
        updateRootClass();
        if (state.fitMode) setZoom(state.fitMode);
        else syncOverlays();
        return;
      }
      try {
        if (root.localStorage) root.localStorage.setItem(which === "rail" ? "fmde_rail_collapsed" : "fmde_insp_collapsed", collapsed ? "1" : "0");
      } catch (e) { /* private mode — session-only pref */ }
      updateRootClass();
      // The canvas just changed width; keep fit zoom modes true to it.
      if (state.fitMode) setZoom(state.fitMode);
      else syncOverlays();
    }

    function modesAvailable() {
      const configured = Array.isArray(opts.allowedModes)
        ? opts.allowedModes.filter(function (mode) { return MODES.indexOf(mode) !== -1; })
        : MODES.slice();
      if (state.profile === "fill" || state.profile === "inline") return configured.indexOf("visual") !== -1 ? ["visual"] : [configured[0] || "visual"];
      // Doc mode is a word-processor projection over paged flow chains — it has
      // no meaning for kind:"view" surfaces (websites, portal pages).
      if (state.doc && state.doc.kind === "view") return ["visual", "preview"].filter(function (mode) { return configured.indexOf(mode) !== -1; });
      return configured.length ? configured : MODES.slice();
    }

    function setMode(next) {
      const avail = modesAvailable();
      let mode = MODES.indexOf(next) !== -1 ? next : "visual";
      if (avail.indexOf(mode) === -1) mode = avail[0] || "visual";
      if (mode === state.mode) return state.mode;
      if (state.textEditing) commitTextEdit();
      docProjection.commitNow("mode-switch");
      docProjection.reset();
      closeComponentCard();
      closeFindPanel();
      if (state.pendingInsert) cancelPendingInsert();
      clearDocWidgetChrome();
      state.docKeyboardObjectId = null;
      state.mode = mode;
      if (mode === "doc") ensureDocumentBodyFrame();
      state.selection = [];
      state.selectedPageId = null;
      state.enterFrameId = null;
      updateRootClass();
      buildToolbar();
      renderRail();
      renderInspector();
      renderCanvas();
      renderOutlinePanel();
      emit("mode", mode);
      emitSelection();
      return mode;
    }

    // ---- display document / rendering ------------------------------------------------

    const widgetContext = {
      // The editable page is the preview surface. Widget settings rebuild the
      // renderer immediately, so the canvas always shows the current result.
      preview: true,
      // Authoring is never an execution surface. Input widgets may show their
      // realistic empty/saved state, but irreversible customer actions such
      // as adopting a signature must remain inert until the issued document
      // is opened through a signing workflow.
      authoring: true,
      definitionResolver: findWidgetDef,
      submitOutput: function (key, value) {
        state.previewOutputs[key] = value;
        emit("output", key, value);
      },
      outputs: state.previewOutputs,
      api: {},
      refresh: function () { renderCanvas(); }
    };

    function docRegionMargins(doc) {
      const configured = M.getPath(doc, "chains.body.page_defaults.margins_pt") || {};
      return {
        top: Number(configured.top) || 72,
        right: Number(configured.right) || 72,
        bottom: Number(configured.bottom) || 72,
        left: Number(configured.left) || 72
      };
    }

    function docRegionChainDefinition(doc, region) {
      const current = M.getPath(doc, "chains." + region);
      if (current) return M.deepClone(current);
      return {
        auto_pages: region === "body",
        page_defaults: {
          role: "body",
          margins_pt: docRegionMargins(doc),
          columns: 1,
          column_gap_pt: 24
        },
        keep_rules: region === "body" ? { widow_lines: 2, orphan_lines: 2 } : {}
      };
    }

    function findPageRegionFrame(page, region) {
      let found = null;
      (function visit(nodes) {
        for (const node of nodes || []) {
          if (found) return;
          if (node && node.type === "frame" && node.props) {
            const pageRegion = String(node.props.page_region || "");
            const chainId = node.props.chain && node.props.chain.id;
            if (pageRegion === region || (region === "body" && chainId && pageRegion.indexOf("header") !== 0 && pageRegion.indexOf("footer") !== 0)) {
              found = node;
              return;
            }
          }
          visit(node && node.children);
        }
      })(page && page.children);
      return found;
    }

    function isDocumentBodyFrame(node) {
      if (!node || node.type !== "frame" || !node.props) return false;
      if (String(node.props.page_region || "") === "body") return true;
      const chainId = node.props.chain && node.props.chain.id;
      const pageRegion = String(node.props.page_region || "");
      return !!chainId && pageRegion.indexOf("header") !== 0 && pageRegion.indexOf("footer") !== 0;
    }

    function createDocRegionText(name, ids) {
      const overrides = {
        name: name + " text",
        anchor: "flow",
        frame: { x: 0, y: 0, w: 0, h: "auto", z: 0, layout: "flow" },
        props: {
          blocks: [{ id: ids && ids.block ? ids.block : M.generateId("blk"), type: "paragraph", style_ref: "Normal text", runs: [{ text: "" }] }],
          valign: "top",
          auto_fit: false,
          line_height: 1.4,
          letter_spacing: 0
        }
      };
      if (ids && ids.node) overrides.id = ids.node;
      return M.createNode("text", overrides);
    }

    function docPageRegionChainId(pageId, region) {
      return "doc_" + String(pageId).replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + region;
    }

    function clonedDocRegionChildren(sourceFrame) {
      if (!sourceFrame || !Array.isArray(sourceFrame.children) || !sourceFrame.children.length) return null;
      const children = M.reassignIds(sourceFrame.children);
      (function refreshBlockIds(nodes) {
        for (const node of nodes || []) {
          if (node.type === "text" && node.props && Array.isArray(node.props.blocks)) {
            node.props.blocks.forEach(function (block) { block.id = M.generateId("blk"); });
          }
          refreshBlockIds(node.children);
        }
      })(children);
      return children;
    }

    function sourcePageRegionFrame(doc, region, excludePageId) {
      for (const candidate of doc.pages || []) {
        if (candidate.id === excludePageId) continue;
        const frame = findPageRegionFrame(candidate, region);
        if (frame) return frame;
      }
      return null;
    }

    function createDocRegionFrame(doc, page, pageIndex, region, placeholder, sourceFrame) {
      const paper = M.paperDimensions(doc);
      const margins = docRegionMargins(doc);
      const width = Math.max(1, paper.w_pt - margins.left - margins.right);
      const regionBox = region === "header"
        ? { x: margins.left, y: 24, w: width, h: 30 }
        : region === "footer"
          ? { x: margins.left, y: Math.max(0, paper.h_pt - 54), w: width, h: 30 }
          : { x: margins.left, y: margins.top, w: width, h: Math.max(1, paper.h_pt - margins.top - margins.bottom) };
      const stable = "fmde_doc_placeholder_" + String(page.id).replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + region;
      const chainId = docPageRegionChainId(page.id, region);
      const text = createDocRegionText(region.charAt(0).toUpperCase() + region.slice(1), placeholder && !sourceFrame ? { node: stable + "_text", block: stable + "_block" } : null);
      const seededChildren = region === "body" ? null : clonedDocRegionChildren(sourceFrame);
      const overrides = {
        name: region.charAt(0).toUpperCase() + region.slice(1),
        frame: { ...regionBox, rotation: 0, z: 0, layout: "flow", constraints: { h: "stretch", v: "top" } },
        props: {
          chain: { id: chainId, index: 0 },
          page_region: region,
          fmde_doc_placeholder: placeholder ? true : undefined,
          fmde_placeholder_page_id: placeholder ? page.id : undefined,
          flow: { direction: "column", gap: 0, padding: [0, 0, 0, 0], align: "stretch", wrap: false },
          overflow: "hidden"
        },
        children: seededChildren || [text]
      };
      if (placeholder) overrides.id = stable + "_frame";
      return M.createNode("frame", overrides);
    }

    /** A paged document must always have one real, editable body in its model.
     * Display-only placeholders are useful for optional header/footer regions,
     * but a missing body leaves Doc mode with no durable caret target. */
    function ensureDocumentBodyFrame() {
      if (!state.doc || state.doc.kind === "view") return null;
      const pages = state.doc.pages || [];
      if (!pages.length || pages.some(function (page) { return !!findPageRegionFrame(page, "body"); })) return null;
      const page = pages[0];
      const frame = createDocRegionFrame(state.doc, page, 0, "body", false);
      frame.props.chain = { id: "body", index: 0 };
      const commands = [];
      if (!M.getPath(state.doc, "chains.body")) {
        commands.push({ type: "doc.set", prop: "chains.body", value: docRegionChainDefinition(state.doc, "body") });
      }
      commands.push({
        type: "node.insert",
        node: frame,
        page_id: page.id,
        index: docRegionInsertIndex(page, "body")
      });
      return runCommands(commands, "restore document body");
    }

    function docRegionInsertIndex(page, region) {
      const children = (page && page.children) || [];
      if (region === "header") return 0;
      if (region === "body") {
        const footerIndex = children.findIndex(function (node) { return node && node.props && node.props.page_region === "footer"; });
        return footerIndex === -1 ? children.length : footerIndex;
      }
      return children.length;
    }

    function buildDocDisplayScaffold(doc) {
      const display = M.deepClone(doc);
      if (!display.chains) display.chains = {};
      for (const region of ["header", "body", "footer"]) {
        if (!display.chains[region]) display.chains[region] = docRegionChainDefinition(display, region);
      }
      (display.pages || []).forEach(function (page, pageIndex) {
        for (const region of ["header", "body", "footer"]) {
          if (findPageRegionFrame(page, region)) continue;
          const sourceFrame = region === "body" ? null : sourcePageRegionFrame(doc, region, page.id);
          const frame = createDocRegionFrame(display, page, pageIndex, region, true, sourceFrame);
          const chainId = frame.props.chain.id;
          if (!display.chains[chainId]) display.chains[chainId] = docRegionChainDefinition(display, region);
          page.children.splice(docRegionInsertIndex(page, region), 0, frame);
        }
      });
      return display;
    }

    function buildDisplayDoc() {
      // Doc mode always edits/renders the SOURCE document — editing a
      // binding-resolved projection would bake resolved values into the doc.
      if (state.mode !== "doc" && state.dataPreview && opts.resolveScope) {
        try {
          return M.resolveBindings(state.doc, opts.resolveScope);
        } catch (err) {
          if (root && root.console) root.console.error("[FMDocEditor] resolveBindings failed", err);
        }
      }
      return state.mode === "doc" ? buildDocDisplayScaffold(state.doc) : state.doc;
    }

    /** Agent-created pages must use the document's real themed safe area, and
     * new children of flow frames must not retain imaginary absolute boxes.
     * The renderer owns a flow child's position; canonicalizing its model
     * frame keeps selection/edit chrome attached to the rendered content. */
    function reconcileAgentDocument(doc, agentSource) {
      const next = M.deepClone(doc);
      if (!next || next.kind === "view" || !Array.isArray(next.pages)) return next;
      const existingIds = new Set();
      M.walkNodes(state.doc, function (node) { if (node && node.id) existingIds.add(node.id); });
      const existingPages = new Set((state.doc.pages || []).map(function (page) { return page.id; }));
      const paper = M.paperDimensions(next);
      const chainMargins = M.getPath(next, "chains.body.page_defaults.margins_pt") ||
        M.getPath(state.doc, "chains.body.page_defaults.margins_pt") || {};
      const theme = currentTheme();

      const safeArea = function (page) {
        const master = M.pageMasterForRole(theme, (page && page.role) || "body") || {};
        const inset = master.content_inset || {};
        const side = function (name) {
          const themed = Number(inset[name]);
          if (Number.isFinite(themed)) return Math.max(0, themed);
          const configured = Number(chainMargins[name]);
          return Number.isFinite(configured) ? Math.max(0, configured) : 72;
        };
        return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
      };

      const regionFrame = function (region, safe) {
        const width = Math.max(1, paper.w_pt - safe.left - safe.right);
        if (region === "header") return {
          x: safe.left, y: Math.max(12, safe.top / 3), w: width,
          h: Math.max(24, safe.top / 2 - 6)
        };
        if (region === "footer") return {
          x: safe.left, y: paper.h_pt - Math.max(42, safe.bottom * .75), w: width,
          h: Math.max(24, safe.bottom / 2 - 6)
        };
        return {
          x: safe.left, y: safe.top, w: width,
          h: Math.max(1, paper.h_pt - safe.top - safe.bottom)
        };
      };

      const visit = function (node, parent, newPage, safe, pageId) {
        if (!node) return;
        const isNew = !!agentSource && (newPage || !existingIds.has(node.id));
        const region = node.props && String(node.props.page_region || "");
        const chainId = node.props && node.props.chain && String(node.props.chain.id || "");
        const generatedRegion = region && chainId === docPageRegionChainId(pageId, region);
        if ((isNew || generatedRegion) && node.type === "frame" && ["header", "body", "footer"].indexOf(region) !== -1) {
          node.frame = Object.assign({}, node.frame || {}, regionFrame(region, safe), { rotation: 0, z: 0, layout: "flow" });
        }
        const parentRegion = parent && parent.props && String(parent.props.page_region || "");
        const parentChain = parent && parent.props && parent.props.chain && String(parent.props.chain.id || "");
        const generatedParent = parentRegion && parentChain === docPageRegionChainId(pageId, parentRegion);
        if ((isNew || generatedParent) && parent && parent.frame && parent.frame.layout === "flow" && node.anchor !== "page") {
          const direction = parent.props && parent.props.flow && parent.props.flow.direction === "row" ? "row" : "column";
          node.frame = Object.assign({}, node.frame || {}, { x: 0, y: 0, layout: "flow" });
          if (direction === "column") node.frame.w = 0;
          if (node.type === "text") node.frame.h = "auto";
        }
        for (const child of node.children || []) visit(child, node, newPage, safe, pageId);
      };

      for (const page of next.pages) {
        const newPage = !existingPages.has(page.id);
        const safe = safeArea(page);
        for (const node of page.children || []) visit(node, null, newPage, safe, page.id);
      }
      const headerOptions = M.getPath(next, "settings.header_options") || {};
      const activeSuffixes = [];
      if (headerOptions.different_first) activeSuffixes.push("first");
      if (headerOptions.different_odd_even) activeSuffixes.push("even");
      for (const suffix of activeSuffixes) {
        for (const kind of ["header", "footer"]) {
          const region = kind + "_" + suffix;
          const source = sourcePageRegionFrame(next, region, null);
          if (!source) continue;
          for (const page of next.pages) {
            if (findPageRegionFrame(page, region)) continue;
            const frame = M.deepClone(source);
            frame.id = M.generateId("nd");
            frame.children = clonedDocRegionChildren(source) || [];
            if (frame.props) delete frame.props.chain;
            page.children.push(frame);
          }
        }
      }
      return next;
    }

    function currentTheme() {
      const themes = opts.catalog && Array.isArray(opts.catalog.themes) ? opts.catalog.themes : [];
      if (M.getPath(state.doc, "metadata.theme_disabled") === true) return null;
      if (!themes.length) return opts.theme || null;
      const themeId = state.doc && state.doc.theme_ref && state.doc.theme_ref.theme_id;
      // Hosts supply their default theme through opts.theme. Documents that
      // predate theme_ref must still render that theme (and expose its named
      // styles) until the user explicitly chooses another one.
      if (!themeId) return opts.theme || null;
      const entry = themes.find(function (theme) {
        return (theme.id || theme.theme_id) === themeId;
      });
      return entry ? (entry.definition || entry) : (opts.theme || null);
    }

    /** A view document's root is its true page background. Paint that same
     *  fill on the scrolling canvas so it continues behind site chrome and
     *  through the stage gutters instead of ending at the root node's box. */
    function syncViewCanvasBackground() {
      if (!dom.canvas) return;
      const canvasStyle = dom.canvas.style;
      ["background", "background-color", "background-image", "background-size", "background-position", "background-repeat"].forEach(function (prop) {
        canvasStyle.removeProperty(prop);
      });
      if (!isViewDoc()) return;
      const fill = state.doc && state.doc.root && state.doc.root.style && state.doc.root.style.fill;
      if (!fill) return;
      if (typeof fill === "string") {
        canvasStyle.background = fill;
        return;
      }
      const opacity = function (value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
      };
      const translucent = function (color, alpha) {
        if (!color || alpha <= 0) return "transparent";
        if (alpha >= 1) return color;
        return "color-mix(in srgb," + color + " " + (alpha * 100) + "%,transparent)";
      };
      if (fill.type === "image") {
        const media = fill.media;
        let url = "";
        if (opts.media && typeof opts.media.url === "function") {
          try { url = opts.media.url(media, media && media.variant) || ""; } catch (err) { url = ""; }
        } else if (typeof media === "string") url = media;
        else if (media && media.url) url = String(media.url);
        if (fill.fallback_color) canvasStyle.backgroundColor = fill.fallback_color;
        if (!url) return;
        const overlayColor = fill.overlay_color;
        const overlayAlpha = opacity(fill.overlay_opacity, overlayColor ? 1 : 0);
        const hasOverlay = !!(overlayColor && overlayAlpha > 0);
        const overlay = hasOverlay ? "linear-gradient(" + translucent(overlayColor, overlayAlpha) + "," + translucent(overlayColor, overlayAlpha) + ")," : "";
        canvasStyle.backgroundImage = overlay + 'url("' + url.replace(/["\\\n\r]/g, "") + '")';
        canvasStyle.backgroundSize = (hasOverlay ? "100% 100%," : "") + (fill.fit === "contain" ? "contain" : "cover");
        canvasStyle.backgroundPosition = (hasOverlay ? "0 0," : "") + "center";
        canvasStyle.backgroundRepeat = hasOverlay ? "no-repeat,no-repeat" : "no-repeat";
        return;
      }
      const css = M.fillToCss(fill);
      if (css) canvasStyle.background = fill.type === "solid" ? translucent(css, opacity(fill.opacity, 1)) : css;
    }

    function renderCanvas() {
      if (state.destroyed) return;
      preserveCanvasScrollForRender();
      syncViewCanvasBackground();
      for (const old of Array.prototype.slice.call(dom.stage.querySelectorAll(".fmde-doc-add-page"))) old.remove();
      const displayDoc = buildDisplayDoc();
      // Wrapper surfaces such as the workflow builder may opt into a live
      // preview: the same canvas, with temporary widget outputs, but without
      // treating it as an authoring surface. Ordinary document Preview stays
      // static/print-true by default.
      const livePreview = state.mode === "preview" && opts.interactivePreview === true;
      widgetContext.authoring = !livePreview;
      const renderOpts = {
        document: displayDoc,
        theme: currentTheme(),
        themeContext: opts.themeContext || null,
        // Preview mode is the static, print-true surface (no handlers).
        mode: state.mode === "preview" && !livePreview ? "static" : "interactive",
        // One authored coordinate system is used by Visual, Preview, HTML and
        // generated output. Theme chrome never adds an output-only offset.
        applyThemeMargins: false,
        widgetData: state.widgetData,
        widgetContext: widgetContext,
        capabilities: opts.capabilities || null,
        // Unresolved documents carry media REFS ({media_id}) — without the
        // host's URL resolver every image renders as a placeholder.
        mediaUrl: opts.media && typeof opts.media.url === "function"
          ? function (media, variant) { return opts.media.url(media, variant) || ""; }
          : null,
        scale: state.zoom
      };
      try {
        if (!state.renderHandle) state.renderHandle = renderer.render(dom.stage, renderOpts);
        else state.renderHandle.update(renderOpts);
        restorePendingCanvasScroll(false);
        state.renderError = null;
      } catch (err) {
        state.renderError = err;
        if (root && root.console) root.console.error("[FMDocEditor] render failed", err);
        dom.stage.innerHTML = '<div class="fmde-render-error">Renderer error: ' + esc(err && err.message) + "</div>";
        state.renderHandle = null;
        return;
      }
      rebuildNodeIndex();
      syncOverlays();
      // Chain layout (line splits, auto pages) happens asynchronously inside
      // the renderer's finalize pass — the doc-mode projection and any chain
      // chrome must wait for it.
      state.renderToken += 1;
      const token = state.renderToken;
      const handle = state.renderHandle;
      const ready = handle && typeof handle.ready === "function" ? handle.ready() : Promise.resolve();
      Promise.resolve(ready).then(function () {
        if (state.destroyed || token !== state.renderToken) return;
        onRenderSettled();
      }).catch(function () { /* render readiness is best-effort */ });
    }

    /** Runs once the renderer finished pagination/chain layout for the last render. */
    function onRenderSettled() {
      // A view renderer remembers its last supplied surface width across
      // updates. Switching Visual -> Preview must replace the authoring width
      // (canvas minus handle gutters) with the real preview viewport before
      // any section is measured or centered.
      if (isViewDoc() && state.renderHandle && typeof state.renderHandle.setViewSurfaceWidth === "function") {
        state.renderHandle.setViewSurfaceWidth(currentViewSurfaceWidth());
      }
      if (state.mode === "doc") {
        docProjection.setup();
        renderDocAddPageControl();
        renderDocWidgetObjects();
        renderBookmarkFlags();
        refreshFindHighlights();
        positionDocImageOverlay();
        if (state.pendingFootnoteFocus) {
          const noteText = dom.stage.querySelector('.fmdoc-footnote-text[data-footnote-id="' + String(state.pendingFootnoteFocus).replace(/"/g, '\\"') + '"]');
          state.pendingFootnoteFocus = null;
          if (noteText) { allowExplicitCanvasScroll(); noteText.scrollIntoView({ block: "center" }); noteText.focus({ preventScroll: true }); }
        }
        renderRulerUI();
        renderCollabCursors();
      } else if (state.mode === "visual") {
        // Re-sync so overlays cover chain-appended auto pages and final split
        // geometry. Never mid text edit (the edit surface lives in an overlay).
        if (!state.textEditing) syncOverlays();
        // Freeze generated flow layout into directly-manipulable absolute
        // geometry, once, as soon as we have real measurements to read.
        if (!state.viewNormalizeTried && !state.textEditing && isViewDoc()) {
          state.viewNormalizeTried = true;
          if (normalizeViewLayout()) return; // re-renders; settles again
        }
      }
      renderCommentThreads();
      // Pagination and caret decoration can change the stage height after the
      // synchronous update. Reapply once more against the final page stack.
      restorePendingCanvasScroll(true);
    }

    function renderDocAddPageControl() {
      for (const old of Array.prototype.slice.call(dom.stage.querySelectorAll(".fmde-doc-add-page"))) old.remove();
      if (state.mode !== "doc" || !state.doc.pages || !state.doc.pages.length) return;
      const button = el("button", {
        type: "button",
        class: "fmde-doc-add-page",
        title: (globalThis.PlatformLanguage?.text("doc-editor","m_4d405fa2a01074","Add page") ?? "Add page"),
        "aria-label": "Add page",
        html: iconSvg("plusplain")
      });
      button.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        docProjection.appendPageBreak();
      });
      dom.stage.appendChild(button);
    }

    function collaborationActor() {
      const source = (opts.collaboration && opts.collaboration.actor) || opts.actor || {};
      const email = String(source.email || "").trim();
      return {
        id: String(source.id || source.user_id || email || "unknown"),
        name: String(source.name || source.display_name || email || "Unknown user"),
        email: email
      };
    }

    function commentAuthor(source) {
      const actor = source && typeof source === "object" ? source : {};
      const email = String(actor.email || "").trim();
      return {
        id: String(actor.id || actor.user_id || email || "unknown"),
        name: String(actor.name || actor.display_name || email || "Unknown user"),
        email: email
      };
    }

    function actorInitials(actor) {
      const words = String((actor && actor.name) || "?").trim().split(/\s+/).filter(Boolean);
      return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
    }

    function commentTime(value) {
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return "";
      try { return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
      catch (err) { return date.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.()); }
    }

    function safeCommentText(value) {
      const text = String(value == null ? "" : value);
      return /^\[?object\s+Promise\]?$/i.test(text.trim()) ? "" : text;
    }

    function updateDocumentComments(mutator, label) {
      const comments = M.deepClone(M.getPath(state.doc, "metadata.comments") || []);
      mutator(comments);
      runCommands([{ type: "doc.set", prop: "metadata.comments", value: comments }], label || "comment");
    }

    /** Render open comment threads beside the line they reference. Comments
     *  remain document metadata; this projection is intentionally absent from
     *  Preview/print output. */
    function renderCommentThreads() {
      for (const card of Array.from(dom.stage.querySelectorAll(".fmde-comment-card"))) card.remove();
      for (const anchor of Array.from(dom.stage.querySelectorAll(".fmde-comment-anchor"))) anchor.classList.remove("fmde-comment-anchor");
      if (state.mode !== "doc") return;
      const comments = M.getPath(state.doc, "metadata.comments") || [];
      const stageRect = dom.stage.getBoundingClientRect();
      let nextTop = 0;
      for (const raw of comments) {
        if (!raw || raw.status === "resolved") continue;
        let blockEl = null;
        for (const candidate of Array.from(dom.stage.querySelectorAll('[data-block-id]'))) {
          if (candidate.getAttribute("data-block-id") !== String(raw.block_id || "")) continue;
          const part = candidate.closest("[data-node-id]");
          if (part && rawNodeId(part.getAttribute("data-node-id") || "") === String(raw.node_id || "")) { blockEl = candidate; break; }
        }
        if (!blockEl) continue;
        blockEl.classList.add("fmde-comment-anchor");
        const author = commentAuthor(raw.author);
        const card = el("aside", { class: "fmde-comment-card", "data-comment-id": String(raw.id || "") });
        const replies = Array.isArray(raw.replies) ? raw.replies : [];
        card.innerHTML =
          '<div class="fmde-comment-head"><span class="fmde-comment-avatar">' + esc(actorInitials(author)) + '</span><span class="fmde-comment-who"><strong>' + esc(author.name) + '</strong><time>' + esc(commentTime(raw.created_at)) + '</time></span></div>' +
          (raw.quote ? '<blockquote class="fmde-comment-quote">' + esc(raw.quote) + '</blockquote>' : "") +
          (safeCommentText(raw.text) ? '<div class="fmde-comment-text">' + esc(safeCommentText(raw.text)) + '</div>' : "") +
          replies.map(function (reply) {
            const replyAuthor = commentAuthor(reply.author);
            return '<div class="fmde-comment-reply"><div class="fmde-comment-head"><span class="fmde-comment-avatar">' + esc(actorInitials(replyAuthor)) + '</span><span class="fmde-comment-who"><strong>' + esc(replyAuthor.name) + '</strong><time>' + esc(commentTime(reply.created_at)) + '</time></span></div>' + (safeCommentText(reply.text) ? '<div class="fmde-comment-text">' + esc(safeCommentText(reply.text)) + '</div>' : "") + '</div>';
          }).join("") +
          `<div class="fmde-comment-compose"><input type="text" aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_801ae6a3c93085","Reply to comment") ?? "Reply to comment")}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_7b1d560830d655","Reply…") ?? "Reply…")}"><button type="button">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_b7aa8fbdbd8d21","Reply") ?? "Reply")}</button></div>` +
          `<div class="fmde-comment-actions"><button type="button" data-resolve-comment>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_0ce2fbc97d05b4","Resolve") ?? "Resolve")}</button></div>`;
        dom.stage.appendChild(card);
        const blockRect = blockEl.getBoundingClientRect();
        const page = blockEl.closest(".fmdoc-page");
        const pageRect = page ? page.getBoundingClientRect() : blockRect;
        const top = Math.max(blockRect.top - stageRect.top, nextTop);
        card.style.left = Math.round(pageRect.right - stageRect.left + 14) + "px";
        card.style.top = Math.round(top) + "px";
        nextTop = top + card.offsetHeight + 8;
        const input = card.querySelector("input");
        const reply = function () {
          const message = String(input.value || "").trim();
          if (!message) return;
          updateDocumentComments(function (list) {
            const thread = list.find(function (item) { return String(item.id) === String(raw.id); });
            if (!thread) return;
            if (!Array.isArray(thread.replies)) thread.replies = [];
            thread.replies.push({ id: M.generateId("reply"), text: message, author: collaborationActor(), created_at: new Date().toISOString() });
          }, "comment:reply");
        };
        card.querySelector(".fmde-comment-compose button").addEventListener("click", reply);
        input.addEventListener("keydown", function (event) { if (event.key === "Enter") { event.preventDefault(); reply(); } });
        card.querySelector("[data-resolve-comment]").addEventListener("click", function () {
          updateDocumentComments(function (list) {
            const thread = list.find(function (item) { return String(item.id) === String(raw.id); });
            if (!thread) return;
            thread.status = "resolved";
            thread.resolved_at = new Date().toISOString();
            thread.resolved_by = collaborationActor();
          }, "comment:resolve");
        });
        card.addEventListener("mousedown", function (event) { event.stopPropagation(); });
      }
      const draft = state.commentDraft;
      if (draft) {
        let blockEl = null;
        for (const candidate of Array.from(dom.stage.querySelectorAll('[data-block-id]'))) {
          if (candidate.getAttribute("data-block-id") !== String(draft.block_id || "")) continue;
          const part = candidate.closest("[data-node-id]");
          if (part && rawNodeId(part.getAttribute("data-node-id") || "") === String(draft.node_id || "")) { blockEl = candidate; break; }
        }
        if (blockEl) {
          blockEl.classList.add("fmde-comment-anchor");
          const author = collaborationActor();
          const card = el("aside", { class: "fmde-comment-card fmde-comment-draft", "data-comment-draft": "" });
          card.innerHTML =
            '<div class="fmde-comment-head"><span class="fmde-comment-avatar">' + esc(actorInitials(author)) + '</span><span class="fmde-comment-who"><strong>' + esc(author.name) + `</strong><time>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_d3df5263d67356","New comment") ?? "New comment")}</time></span></div>` +
            (draft.quote ? '<blockquote class="fmde-comment-quote">' + esc(draft.quote) + '</blockquote>' : "") +
            ("<textarea aria-label=\"" + (globalThis.PlatformLanguage?.htmlText("doc-editor","m_198a6682f7940c","Comment") ?? "Comment") + "\" placeholder=\"" + (globalThis.PlatformLanguage?.htmlText("doc-editor","m_8637281815b15c","Add a comment…") ?? "Add a comment…") + "\"></textarea>") +
            `<div class="fmde-comment-actions"><button type="button" data-cancel-comment>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" data-save-comment disabled>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_198a6682f7940c","Comment") ?? "Comment")}</button></div>`;
          dom.stage.appendChild(card);
          const blockRect = blockEl.getBoundingClientRect();
          const page = blockEl.closest(".fmdoc-page");
          const pageRect = page ? page.getBoundingClientRect() : blockRect;
          const top = Math.max(blockRect.top - stageRect.top, nextTop);
          card.style.left = Math.round(pageRect.right - stageRect.left + 14) + "px";
          card.style.top = Math.round(top) + "px";
          nextTop = top + card.offsetHeight + 8;
          const textarea = card.querySelector("textarea");
          const save = card.querySelector("[data-save-comment]");
          textarea.value = String(draft.text || "");
          const syncSave = function () {
            draft.text = textarea.value;
            save.disabled = !textarea.value.trim();
          };
          const submit = function () {
            const message = String(textarea.value || "").trim();
            if (!message) return;
            const comments = M.deepClone(M.getPath(state.doc, "metadata.comments") || []);
            comments.push({
              id: M.generateId("cmt"), text: message,
              node_id: draft.node_id, block_id: draft.block_id,
              offset: draft.offset, end_offset: draft.end_offset, quote: draft.quote,
              author: collaborationActor(), status: "open", replies: [], created_at: new Date().toISOString()
            });
            state.commentDraft = null;
            runCommands([{ type: "doc.set", prop: "metadata.comments", value: comments }], "comment:add");
            docProjection.hint("Comment added");
          };
          textarea.addEventListener("input", syncSave);
          textarea.addEventListener("keydown", function (event) {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); }
            else if (event.key === "Escape") { event.preventDefault(); state.commentDraft = null; renderCommentThreads(); docProjection.restoreLastCaret(true); }
          });
          save.addEventListener("click", submit);
          card.querySelector("[data-cancel-comment]").addEventListener("click", function () { state.commentDraft = null; renderCommentThreads(); docProjection.restoreLastCaret(true); });
          card.addEventListener("mousedown", function (event) { event.stopPropagation(); });
          syncSave();
          if (draft.focusRequested) {
            draft.focusRequested = false;
            root.requestAnimationFrame(function () { if (textarea.isConnected) textarea.focus(); });
          }
        }
      }
      const suggestions = M.getPath(state.doc, "metadata.suggestions") || [];
      for (const raw of suggestions) {
        if (!raw || (raw.status && raw.status !== "pending")) continue;
        let blockEl = null;
        for (const candidate of Array.from(dom.stage.querySelectorAll('[data-block-id]'))) {
          if (candidate.getAttribute("data-block-id") !== String(raw.block_id || "")) continue;
          const part = candidate.closest("[data-node-id]");
          if (part && rawNodeId(part.getAttribute("data-node-id") || "") === String(raw.node_id || "")) { blockEl = candidate; break; }
        }
        if (!blockEl) continue;
        blockEl.classList.add("fmde-comment-anchor");
        const author = commentAuthor(raw.author);
        const card = el("aside", { class: "fmde-comment-card fmde-suggestion-card", "data-suggestion-id": String(raw.id || "") });
        card.innerHTML =
          '<div class="fmde-comment-head"><span class="fmde-comment-avatar">' + esc(actorInitials(author)) + '</span><span class="fmde-comment-who"><strong>' + esc(author.name) + ' suggested</strong><time>' + esc(commentTime(raw.created_at)) + '</time></span></div>' +
          `<div class="fmde-suggestion-change"><b>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_c313c42d1f7a10","From") ?? "From")}</b><span class="fmde-suggestion-before">` + esc(raw.before_text || "") + `</span><b>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_af8bc9e774b68c","To") ?? "To")}</b><span class="fmde-suggestion-after">` + esc(raw.replacement || "(delete)") + '</span></div>' +
          (raw.note ? '<div class="fmde-comment-text" style="margin-top:7px">' + esc(raw.note) + '</div>' : "") +
          `<div class="fmde-comment-actions"><button type="button" data-reject-suggestion>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_caf34b0bba6d77","Reject") ?? "Reject")}</button><button type="button" data-accept-suggestion>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_b550215be01e52","Accept") ?? "Accept")}</button></div>`;
        dom.stage.appendChild(card);
        const blockRect = blockEl.getBoundingClientRect();
        const page = blockEl.closest(".fmdoc-page");
        const pageRect = page ? page.getBoundingClientRect() : blockRect;
        const top = Math.max(blockRect.top - stageRect.top, nextTop);
        card.style.left = Math.round(pageRect.right - stageRect.left + 14) + "px";
        card.style.top = Math.round(top) + "px";
        nextTop = top + card.offsetHeight + 8;
        card.querySelector("[data-accept-suggestion]").addEventListener("click", function () {
          const list = M.deepClone(M.getPath(state.doc, "metadata.suggestions") || []);
          const suggestion = list.find(function (item) { return String(item.id) === String(raw.id); });
          if (!suggestion) return;
          suggestion.status = "accepted";
          suggestion.reviewed_at = new Date().toISOString();
          suggestion.reviewed_by = collaborationActor();
          docProjection.applySuggestion(suggestion, list);
        });
        card.querySelector("[data-reject-suggestion]").addEventListener("click", function () {
          const list = M.deepClone(M.getPath(state.doc, "metadata.suggestions") || []);
          const suggestion = list.find(function (item) { return String(item.id) === String(raw.id); });
          if (!suggestion) return;
          suggestion.status = "rejected";
          suggestion.reviewed_at = new Date().toISOString();
          suggestion.reviewed_by = collaborationActor();
          runCommands([{ type: "doc.set", prop: "metadata.suggestions", value: list }], "suggestion:reject");
        });
        card.addEventListener("mousedown", function (event) { event.stopPropagation(); });
      }
    }

    function rebuildNodeIndex() {
      state.nodeIndex = new Map();
      // View docs have no pages; their nodes map onto the renderer's single
      // synthetic page element ("view_root") so overlays/selection work.
      const viewPageId = isViewDoc() ? "view_root" : null;
      M.walkNodes(state.doc, function (node, ctx) {
        state.nodeIndex.set(node.id, {
          node: node,
          parentId: ctx.parent ? ctx.parent.id : null,
          pageId: ctx.page ? ctx.page.id : viewPageId,
          index: ctx.index,
          depth: ctx.depth
        });
      });
      if (!state.currentPageId || !M.findPage(state.doc, state.currentPageId)) {
        state.currentPageId = state.doc.pages && state.doc.pages.length ? state.doc.pages[0].id : null;
      }
    }

    function pruneSelection() {
      rebuildNodeIndex();
      const kept = state.selection.filter(function (id) { return state.nodeIndex.has(id); });
      if (kept.length !== state.selection.length) {
        state.selection = kept;
        emitSelection();
      }
    }

    // ---- overlays ---------------------------------------------------------------------

    function pageElements() {
      if (state.renderHandle && typeof state.renderHandle.pageElements === "function") {
        try { return state.renderHandle.pageElements() || []; } catch (err) { /* fall through */ }
      }
      return Array.prototype.slice.call(dom.stage.querySelectorAll(".fmdoc-page"));
    }

    function syncOverlays() {
      cancelCropSession(); // the crop UI lives in an overlay being rebuilt
      for (const entry of state.pageEntries) {
        if (entry.overlay && entry.overlay.parentNode) entry.overlay.parentNode.removeChild(entry.overlay);
      }
      state.pageEntries = [];
      // Doc + preview modes have no overlay layer: preview is static, doc mode
      // interacts with the rendered chain content directly.
      if (state.mode !== "visual") {
        drawSelection();
        return;
      }
      const paper = dims();
      const pages = pageElements();
      for (const pageEl of pages) {
        const pageId = pageEl.getAttribute("data-page-id") || "";
        if (getComputedStyle(pageEl).position === "static") pageEl.style.position = "relative";
        const overlay = el("div", { class: "fmde-overlay", "data-fmde-page": pageId });
        const chrome = el("div", { class: "fmde-guides fmde-static-chrome" });
        const guides = el("div", { class: "fmde-guides" });
        const boxes = el("div", { class: "fmde-selboxes" });
        overlay.appendChild(chrome);
        overlay.appendChild(guides);
        overlay.appendChild(boxes);
        pageEl.appendChild(overlay);
        // View pages render at 100% / design width, not the paper width — the
        // pt<->px conversions (pagePoint, --fmde-px, popovers) must come from
        // the real element or every gesture lands at the wrong coordinate.
        const pageWpt = isViewDoc() && pageEl.offsetWidth ? pageEl.offsetWidth / PX_PER_PT : paper.w_pt;
        const pageHpt = isViewDoc() && pageEl.offsetHeight ? pageEl.offsetHeight / PX_PER_PT : paper.h_pt;
        const entry = { pageId: rawNodeId(pageId), displayPageId: pageId, pageEl: pageEl, overlay: overlay, chrome: chrome, guides: guides, boxes: boxes, w_pt: pageWpt, h_pt: pageHpt };
        overlay.addEventListener("pointerdown", function (ev) { onOverlayPointerDown(entry, ev); });
        overlay.addEventListener("contextmenu", function (ev) { onOverlayContextMenu(entry, ev); });
        overlay.addEventListener("dblclick", function (ev) { onOverlayDblClick(entry, ev); });
        state.pageEntries.push(entry);
        updateOverlayMetrics(entry);
        drawChainChrome(entry);
      }
      applyOverlayMode();
      drawSelection();
    }

    /** View pages: dragging a SECTION's side (e/w) handle resizes the PAGE
     *  width — sections always span the page, so their horizontal edges ARE
     *  the page edges. Replaces the old free-floating side grab-bars. On a
     *  fluid ("fill") page, the drag converts it to a fixed width. The page
     *  is centered in the stage, so a one-sided drag grows both sides (×2)
     *  to keep the dragged edge under the pointer. */
    function resizePageWidth(entry, downEv, side) {
      downEv.preventDefault();
      downEv.stopPropagation();
      const startX = downEv.clientX;
      const rect = entry.pageEl.getBoundingClientRect();
      const zoom = state.zoom || 1;
      const startWPx = rect.width / zoom;                 // unscaled CSS px
      const sectionId = state.selection.length === 1 ? state.selection[0] : null;
      const boxEl = sectionId ? state.selBoxes.get(sectionId) : null;
      const deltaAt = function (ev) { return (ev.clientX - startX) / zoom * (side === "left" ? -2 : 2); };
      trackPointer(downEv, function (mv) {
        const wPx = clamp(startWPx + deltaAt(mv), 320, 3840);
        const wPt = wPx * (72 / 96);
        entry.pageEl.style.width = wPt + "pt"; // live preview only
        entry.pageEl.style.maxWidth = "none";
        // The section spans the page — keep its selection box glued to it.
        if (boxEl) {
          boxEl.style.left = "0pt";
          boxEl.style.width = wPt + "pt";
        }
        dom.hint.textContent = Math.round(wPx) + " px";
        dom.hint.classList.add("show");
      }, function (uv) {
        dom.hint.classList.remove("show");
        const dPx = deltaAt(uv);
        const wPx = clamp(startWPx + dPx, 320, 3840);
        if (Math.abs(dPx) < 2) { renderCanvas(); return; }  // click, not a drag
        const wPt = clamp(Math.round(wPx * (72 / 96)), 240, 2880);
        // Keep the root frame's design width in step — viewDesignWidthPt()
        // takes the max of both, so a stale wider root would cap the fit
        // zoom and the page rendered narrower than the committed width.
        commitGuarded([
          { type: "doc.set", prop: "settings.paper.size", value: { w_pt: wPt } },
          { type: "doc.set", prop: "root.frame.w", value: wPt }
        ], "paper");
        setZoom(state.fitMode || state.zoom);
        renderInspector();
      });
    }

    /** Visual-mode v2 chrome: link badges + tint on chained frames. */
    function drawChainChrome(entry) {
      const page = M.findPage(state.doc, entry.pageId);
      if (!page) return; // chain-appended auto pages have no source page
      const visit = function (node) {
        if (!node || node.visible === false) return;
        const chain = node.props && node.props.chain;
        if (chain && chain.id) {
          const box = overlayBox(node.id);
          if (box && box.pageId === entry.pageId) {
            entry.chrome.appendChild(el("div", {
              class: "fmde-chaintint",
              style: { left: box.x + "pt", top: box.y + "pt", width: Math.max(0, box.w) + "pt", height: Math.max(0, box.h) + "pt" }
            }));
            entry.chrome.appendChild(el("div", {
              class: "fmde-chainchip",
              text: String(chain.id) + " · " + ((Number(chain.index) || 0) + 1),
              style: { left: box.x + "pt", top: box.y + "pt" }
            }));
          }
        }
        if (Array.isArray(node.children)) node.children.forEach(visit);
      };
      (page.page.children || []).forEach(visit);
    }

    /** Keep chrome (borders, handles) visually 1px at any zoom via a CSS var. */
    function updateOverlayMetrics(entry) {
      const rect = entry.pageEl.getBoundingClientRect();
      if (!rect.width) return;
      // Fluid website pages can be rebuilt at desktop width and then narrowed
      // in place for the device preview. Re-read their live layout width so
      // resize grips do not retain the much larger desktop pt-per-pixel ratio.
      const liveWidthPt = isViewDoc() && entry.pageEl.offsetWidth
        ? entry.pageEl.offsetWidth / PX_PER_PT
        : entry.w_pt;
      if (isViewDoc()) entry.w_pt = liveWidthPt;
      const ptPerVisualPx = liveWidthPt / rect.width;
      entry.ptPerPx = ptPerVisualPx;
      entry.overlay.style.setProperty("--fmde-px", ptPerVisualPx + "pt");
    }

    function applyOverlayMode() {
      const fill = state.profile === "fill";
      for (const entry of state.pageEntries) {
        entry.overlay.classList.toggle("fmde-overlay-pass", fill);
        if (fill) buildFillHotspots(entry);
      }
    }

    /** In fill profile the overlay lets clicks through to interactive widgets,
     *  with explicit hotspots over text nodes whose content is unlocked. */
    function buildFillHotspots(entry) {
      Array.prototype.slice.call(entry.overlay.querySelectorAll(".fmde-hotspot")).forEach(function (n) { n.remove(); });
      const page = M.findPage(state.doc, entry.pageId);
      if (!page) return;
      const visit = function (node) {
        if (node.visible === false) return;
        if (node.type === "text" && !lockBlocked(node, "content")) {
          const box = overlayBox(node.id);
          if (box) {
            const hot = el("div", {
              class: "fmde-hotspot",
              title: (globalThis.PlatformLanguage?.text("doc-editor","m_5497d26c3117f4","Click to edit text") ?? "Click to edit text"),
              style: { left: box.x + "pt", top: box.y + "pt", width: box.w + "pt", height: box.h + "pt", transform: box.rotation ? "rotate(" + box.rotation + "deg)" : "" }
            });
            hot.addEventListener("click", function (ev) {
              ev.stopPropagation();
              startTextEdit(node.id);
            });
            entry.overlay.appendChild(hot);
          }
        }
        if (Array.isArray(node.children)) node.children.forEach(visit);
      };
      (page.page.children || []).forEach(visit);
    }

    function entryForPage(pageId) {
      for (const entry of state.pageEntries) if (entry.pageId === pageId) return entry;
      return null;
    }

    function rawNodeId(displayId) {
      return String(displayId || "").replace(/__r\d+$/, "");
    }

    function pagePoint(entry, ev) {
      const rect = entry.pageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: 0, y: 0 };
      const kx = entry.w_pt / rect.width;
      // View pages are content-height (not paper-height); the render scale is
      // uniform, so the horizontal ratio is the true pt-per-px on both axes.
      const ky = isViewDoc() ? kx : entry.h_pt / rect.height;
      return { x: (ev.clientX - rect.left) * kx, y: (ev.clientY - rect.top) * ky };
    }

    /** Absolute node frame within its page, in pt (renderer-measured with a
     *  doc-tree fallback). Rotation is the node's own frame rotation. */
    function rawOverlayBox(nodeId) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info) return null;
      let box = null;
      if (state.renderHandle && typeof state.renderHandle.measureNode === "function") {
        try { box = state.renderHandle.measureNode(nodeId); } catch (err) { box = null; }
      }
      if (!box || !Number.isFinite(box.x)) {
        // Fallback: accumulate parent offsets from the doc tree.
        let x = num(info.node.frame && info.node.frame.x, 0);
        let y = num(info.node.frame && info.node.frame.y, 0);
        let parentId = info.parentId;
        let hops = 0;
        while (parentId && hops < 64) {
          const parent = state.nodeIndex.get(parentId);
          if (!parent) break;
          x += num(parent.node.frame && parent.node.frame.x, 0);
          y += num(parent.node.frame && parent.node.frame.y, 0);
          parentId = parent.parentId;
          hops += 1;
        }
        box = { x: x, y: y, w: num(info.node.frame && info.node.frame.w, 0), h: num(info.node.frame && info.node.frame.h, 0) };
      }
      return {
        x: box.x, y: box.y, w: box.w, h: box.h,
        rotation: num(info.node.frame && info.node.frame.rotation, 0),
        pageId: info.pageId
      };
    }

    /** Groups can temporarily outgrow their authored frame while responsive
     * descendants are being resized or projected at another viewport width.
     * Selection and the next resize gesture must describe what is actually
     * painted, so expand an unrotated group's measured box to the union of all
     * live descendants. Including the authored box preserves intentional empty
     * group space while guaranteeing that no member sits outside the border. */
    function overlayBox(nodeId) {
      const id = rawNodeId(nodeId);
      const info = state.nodeIndex.get(id);
      const base = rawOverlayBox(nodeId);
      if (!base || !info || !isGroupNode(info.node) || base.rotation) return base;
      let minX = base.x;
      let minY = base.y;
      let maxX = base.x + base.w;
      let maxY = base.y + base.h;
      let found = false;
      for (const child of info.node.children || []) {
        const childBox = overlayBox(child.id);
        if (!childBox || childBox.pageId !== base.pageId) continue;
        const bounds = M.frameBounds({
          x: childBox.x, y: childBox.y, w: childBox.w, h: childBox.h,
          rotation: childBox.rotation || 0
        });
        if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)) continue;
        minX = Math.min(minX, bounds.x);
        minY = Math.min(minY, bounds.y);
        maxX = Math.max(maxX, bounds.x + bounds.w);
        maxY = Math.max(maxY, bounds.y + bounds.h);
        found = true;
      }
      if (!found) return base;
      return {
        x: roundPt(minX), y: roundPt(minY),
        w: roundPt(Math.max(0, maxX - minX)), h: roundPt(Math.max(0, maxY - minY)),
        rotation: 0, pageId: base.pageId
      };
    }

    /** Measured geometry expressed the way frame.x/y are: parent-relative. */
    function measuredFrame(nodeId) {
      const info = state.nodeIndex.get(nodeId);
      if (!info) return null;
      const box = overlayBox(nodeId);
      if (!box || !Number.isFinite(box.x)) return null;
      let ox = 0;
      let oy = 0;
      if (info.parentId) {
        const parentBox = overlayBox(info.parentId);
        if (parentBox && Number.isFinite(parentBox.x)) { ox = parentBox.x; oy = parentBox.y; }
      }
      return { x: roundPt(box.x - ox), y: roundPt(box.y - oy), w: roundPt(box.w), h: roundPt(box.h) };
    }

    /** Frame to anchor a drag/resize on: model values where they are real
     *  numbers, measured geometry wherever they are missing or "auto".
     *  Without this, gestures on auto-sized nodes computed NaN and silently
     *  committed a broken frame. */
    function gestureFrame(node) {
      const frame = M.deepClone(node.frame || {});
      // For a flow child (page section) the stored x/y/w are NOT where it is —
      // its parent's layout places it. Always anchor the gesture on measured
      // geometry, or the maths resolves against 0,0 and the result explodes.
      if (isFlowChild(node.id)) {
        const measured = measuredFrame(node.id);
        if (measured) return Object.assign(frame, measured);
      }
      const responsiveResize = isViewDoc() && M.normalizeResponsiveResize
        ? M.normalizeResponsiveResize(node.frame && node.frame.responsive)
        : null;
      if (responsiveHorizontalEligible(node.id) && responsiveResize && responsiveResize.mode === "auto") {
        const measured = measuredFrame(node.id);
        if (measured) {
          // Pointer geometry lives in the currently rendered responsive
          // coordinate space. Keep all four dimensions together; combining a
          // measured x with authored w/h makes an item jump on pickup.
          Object.assign(frame, measured);
          frame.__fmde_rendered_responsive = true;
          return frame;
        }
      }
      if (responsiveHorizontalEligible(node.id)) {
        const measured = measuredFrame(node.id);
        if (measured && Number.isFinite(measured.x)) frame.x = measured.x;
      }
      const missing = ["x", "y", "w", "h"].filter(function (k) { return typeof frame[k] !== "number"; });
      if (!missing.length) return frame;
      const measured = measuredFrame(node.id);
      if (!measured) return frame;
      for (const key of missing) frame[key] = measured[key];
      return frame;
    }

    function nodeMovable(node) {
      return can("free_transform") && !lockBlocked(node, "move");
    }
    function nodeResizable(node) {
      return can("resize") && !lockBlocked(node, "resize");
    }

    function widgetResizeAxes(node) {
      const ref = widgetRefParts(node && node.props && (node.props.widget_ref || node.props.widget));
      const def = ref && findWidgetDef(ref.id, ref.version);
      const setting = def && def.resizeAxes;
      if (setting === "horizontal") return { x: true, y: false };
      if (setting === "vertical") return { x: false, y: true };
      if (setting === "none") return { x: false, y: false };
      if (setting && typeof setting === "object") return { x: setting.x !== false, y: setting.y !== false };
      return { x: true, y: true };
    }
    function nodeRotatable(node) {
      return can("rotate") && !isStructuralSection(node && node.id) && !lockBlocked(node, "rotate");
    }

    function widgetLayoutMode(node) {
      const requested = node && node.props && node.props.object_layout;
      if (["flow", "inline", "front", "behind"].indexOf(requested) !== -1) return requested;
      if (node && node.anchor === "inline") return "inline";
      if (node && node.anchor === "page") return num(node.frame && node.frame.z, 0) < 0 ? "behind" : "front";
      return "flow";
    }

    function widgetLayoutIcon(kind) {
      const open = '<svg viewBox="0 0 24 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">';
      if (kind === "flow") return open + '<path opacity=".62" d="M2 3.5h20M2 16.5h20"/><rect x="7.5" y="6" width="9" height="8" rx="1.2"/></svg>';
      if (kind === "inline") return open + '<path opacity=".62" d="M2 3.5h20M2 16.5h20M2 10h4.5M17.5 10H22"/><rect x="8" y="6" width="8" height="8" rx="1.2"/></svg>';
      if (kind === "front") return open + '<path opacity=".48" d="M2 4h20M2 8h20M2 12h20M2 16h20"/><rect x="7.5" y="5.5" width="9" height="9" rx="1.2" fill="white" stroke-width="1.65"/></svg>';
      return open + '<rect x="7.5" y="5.5" width="9" height="9" rx="1.2" fill="white"/><path opacity=".82" d="M2 4h20M2 8h20M2 12h20M2 16h20"/></svg>';
    }

    function widgetLayoutButtons(node, className) {
      const active = widgetLayoutMode(node);
      const bar = el("span", { class: className || "fmde-object-layout", contenteditable: "false", "aria-label": "Object text layout" });
      const choices = [
        { id: "flow", title: (globalThis.PlatformLanguage?.text("doc-editor","m_0eacf32d51de67","Top and Bottom") ?? "Top and Bottom") },
        { id: "inline", title: (globalThis.PlatformLanguage?.text("doc-editor","m_98e3abc6a57114","In Line with Text") ?? "In Line with Text") },
        { id: "front", title: (globalThis.PlatformLanguage?.text("doc-editor","m_9a87df9fb53f3a","In Front of Text") ?? "In Front of Text") },
        { id: "behind", title: (globalThis.PlatformLanguage?.text("doc-editor","m_980611f768c18a","Behind Text") ?? "Behind Text") }
      ];
      choices.forEach(function (choice) {
        const button = el("button", { type: "button", class: active === choice.id ? "active" : "", html: widgetLayoutIcon(choice.id), title: choice.title, "aria-label": choice.title, "aria-pressed": active === choice.id ? "true" : "false", "data-widget-layout": choice.id });
        button.addEventListener("pointerdown", function (event) { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); setWidgetLayout(node.id, choice.id); });
        bar.appendChild(button);
      });
      return bar;
    }

    function widgetAnchorBlock(nodeId) {
      const rendered = dom.stage.querySelector('[data-node-id="' + String(nodeId).replace(/"/g, '\\"') + '"]');
      const containing = rendered && rendered.closest("[data-block-id]");
      if (containing) return containing.getAttribute("data-block-id");
      const info = state.nodeIndex.get(nodeId);
      const parent = info && info.parentId ? state.nodeIndex.get(info.parentId) : null;
      for (const sibling of (parent && parent.node && parent.node.children) || []) {
        if (sibling.type !== "text") continue;
        const blocks = (sibling.props && sibling.props.blocks) || [];
        if (blocks.length) return blocks[0].id;
      }
      return null;
    }

    function defaultWidgetFlowFrame() {
      let preferred = null;
      let fallback = null;
      M.walkNodes(state.doc, function (candidate) {
        if (candidate.type !== "frame" || !(candidate.props && candidate.props.chain)) return;
        if (!fallback) fallback = candidate;
        if (!preferred && String(candidate.props.chain.id || "") === "body") preferred = candidate;
      });
      return preferred || fallback;
    }

    function setWidgetLayout(nodeId, mode) {
      const info = state.nodeIndex.get(nodeId);
      if (!info || !isDocModeObject(info.node)) return;
      const node = info.node;
      const measured = gestureFrame(node);
      const width = Math.max(MIN_NODE_SIZE_PT, num(measured.w, num(node.frame && node.frame.w, 120)) || 120);
      const height = Math.max(MIN_NODE_SIZE_PT, num(measured.h, num(node.frame && node.frame.h, 80)) || 80);
      const commands = [{ type: "node.set", node_id: nodeId, prop: "props.object_layout", value: mode }];
      if (mode === "flow") {
        const flowFrame = defaultWidgetFlowFrame();
        if (flowFrame && info.parentId !== flowFrame.id) commands.push({ type: "node.move", node_id: nodeId, parent_id: flowFrame.id, index: (flowFrame.children || []).length });
        commands.push({ type: "node.set", node_id: nodeId, prop: "anchor", value: "flow" });
        if (node.type === "widget") {
          commands.push({ type: "node.set", node_id: nodeId, prop: "props.config._fm_flow_resize_offset_x", value: 0 });
          commands.push({ type: "node.set", node_id: nodeId, prop: "props.config._fm_flow_resize_offset_y", value: 0 });
        }
        commands.push({ type: "node.set", node_id: nodeId, prop: "frame", value: Object.assign({}, node.frame, { x: 0, y: 0, w: width, h: height, z: 0, layout: "flow" }) });
      } else if (mode === "inline") {
        const flowFrame = defaultWidgetFlowFrame();
        if (flowFrame && info.parentId !== flowFrame.id) commands.push({ type: "node.move", node_id: nodeId, parent_id: flowFrame.id, index: (flowFrame.children || []).length });
        let blockId = widgetAnchorBlock(nodeId);
        if (!blockId && flowFrame) {
          for (const sibling of flowFrame.children || []) {
            const blocks = sibling.type === "text" && sibling.props && sibling.props.blocks;
            if (blocks && blocks.length) { blockId = blocks[0].id; break; }
          }
        }
        commands.push({ type: "node.set", node_id: nodeId, prop: "anchor", value: "inline" });
        if (node.type === "widget") {
          commands.push({ type: "node.set", node_id: nodeId, prop: "props.config._fm_flow_resize_offset_x", value: 0 });
          commands.push({ type: "node.set", node_id: nodeId, prop: "props.config._fm_flow_resize_offset_y", value: 0 });
        }
        if (blockId) commands.push({ type: "node.set", node_id: nodeId, prop: "props.after_block", value: blockId });
        commands.push({ type: "node.set", node_id: nodeId, prop: "props.inline_offset", value: 9999 });
        commands.push({ type: "node.set", node_id: nodeId, prop: "frame", value: Object.assign({}, node.frame, { x: 0, y: 0, w: width, h: height, z: 0 }) });
      } else {
        commands.push({ type: "node.set", node_id: nodeId, prop: "anchor", value: "page" });
        // "Behind text" is still authored content. A negative z-index can put
        // it beneath the paper's own background, making it appear deleted.
        commands.push({ type: "node.set", node_id: nodeId, prop: "frame", value: Object.assign({}, measured, { w: width, h: height, z: mode === "behind" ? 0 : Math.max(1, num(measured.z, 1)) }) });
      }
      runCommands(commands, "object-layout:" + mode);
    }

    function positionDocWidgetChrome(chrome, widgetEl) {
      if (!chrome || !widgetEl || !chrome.isConnected || !widgetEl.isConnected) return;
      const stageRect = dom.stage.getBoundingClientRect();
      const widgetRect = widgetEl.getBoundingClientRect();
      chrome.style.left = (widgetRect.left - stageRect.left) + "px";
      chrome.style.top = (widgetRect.top - stageRect.top) + "px";
      chrome.style.width = widgetRect.width + "px";
      chrome.style.height = widgetRect.height + "px";
    }

    function positionDocWidgetControls() {
      dom.stage.querySelectorAll(".fmde-doc-object-chrome").forEach(function (chrome) {
        positionDocWidgetChrome(chrome, chrome._fmdeWidgetEl);
      });
    }

    function clearDocWidgetGuides() {
      dom.stage.querySelectorAll(".fmde-doc-guide").forEach(function (guide) { guide.remove(); });
    }

    function clearDocWidgetChrome() {
      dom.stage.querySelectorAll(".fmde-doc-object-chrome,.fmde-doc-object-controls,.fmde-doc-object-resize,.fmde-doc-guide").forEach(function (item) { item.remove(); });
      dom.stage.querySelectorAll(".fmde-doc-object,.fmde-doc-object-dragging").forEach(function (item) {
        item.classList.remove("fmde-doc-object", "fmde-doc-object-dragging");
        item.style.transform = item._fmdeDocBaseTransform || "";
      });
    }

    function isDocModeObject(node) {
      // Widgets retain their existing Doc behavior in every layout mode.
      // Other node types join it only when Visual explicitly anchored them to
      // the page, so headers, body frames and ordinary flowing text never
      // become accidental draggable objects.
      return !!node && (node.type === "widget" || node.type === "table" || node.anchor === "page");
    }

    function docWidgetSnapLines(widgetEl, excludeIds) {
      const page = widgetEl.closest(".fmdoc-page");
      if (!page) return null;
      const pageRect = page.getBoundingClientRect();
      const v = [pageRect.left, pageRect.left + pageRect.width / 2, pageRect.right];
      const h = [pageRect.top, pageRect.top + pageRect.height / 2, pageRect.bottom];
      const boxes = [];
      const seenBoxes = new Set();
      const excluded = new Set((excludeIds || []).map(rawNodeId));
      page.querySelectorAll("[data-node-id],[data-page-region],[data-block-id],.fmde-docedit").forEach(function (candidate) {
        if (candidate === widgetEl || widgetEl.contains(candidate) || candidate.closest('[data-node-id="' + String(widgetEl.getAttribute("data-node-id") || "").replace(/"/g, '\\"') + '"]') === widgetEl) return;
        let owner = candidate;
        while (owner && owner !== page) {
          if (owner.hasAttribute && excluded.has(rawNodeId(owner.getAttribute("data-node-id") || ""))) return;
          owner = owner.parentElement;
        }
        const rect = candidate.getBoundingClientRect();
        if (!rect.width && !rect.height) return;
        v.push(rect.left, rect.left + rect.width / 2, rect.right);
        h.push(rect.top, rect.top + rect.height / 2, rect.bottom);
        const candidateId = candidate.hasAttribute("data-node-id") ? rawNodeId(candidate.getAttribute("data-node-id") || "") : "";
        if (candidateId && !seenBoxes.has(candidateId)) {
          seenBoxes.add(candidateId);
          boxes.push({ id: candidateId, x: rect.left, y: rect.top, w: rect.width, h: rect.height });
        }
      });
      return { v: v, h: h, boxes: boxes, pageRect: pageRect };
    }

    function showDocWidgetGuides(lines, snap) {
      clearDocWidgetGuides();
      if (!lines) return;
      const stageRect = dom.stage.getBoundingClientRect();
      if (snap.vLine !== null) dom.stage.appendChild(el("div", { class: "fmde-doc-guide fmde-doc-guide-v", style: { left: (snap.vLine - stageRect.left) + "px", top: (lines.pageRect.top - stageRect.top) + "px", height: lines.pageRect.height + "px" } }));
      if (snap.hLine !== null) dom.stage.appendChild(el("div", { class: "fmde-doc-guide fmde-doc-guide-h", style: { left: (lines.pageRect.left - stageRect.left) + "px", top: (snap.hLine - stageRect.top) + "px", width: lines.pageRect.width + "px" } }));
      if (snap.equalGap) dom.stage.appendChild(el("div", {
        class: "fmde-doc-guide fmde-doc-guide-gap",
        style: {
          left: (snap.equalGap.startX - stageRect.left) + "px",
          top: (snap.equalGap.y - stageRect.top) + "px",
          width: Math.max(0, snap.equalGap.endX - snap.equalGap.startX) + "px"
        }
      }));
      if (snap.equalGap) dom.stage.appendChild(el("div", {
        class: "fmde-doc-guide fmde-doc-guide-gap fmde-doc-guide-gap-reference",
        style: {
          left: (snap.equalGap.referenceStartX - stageRect.left) + "px",
          top: (snap.equalGap.referenceY - stageRect.top) + "px",
          width: Math.max(0, snap.equalGap.referenceEndX - snap.equalGap.referenceStartX) + "px"
        }
      }));
    }

    function nearestDocWidgetSnap(value, candidates) {
      let line = null;
      let distance = SNAP_TOLERANCE_PX + 1;
      for (const candidate of candidates || []) {
        const nextDistance = Math.abs(candidate - value);
        if (nextDistance <= SNAP_TOLERANCE_PX && nextDistance < distance) {
          line = candidate;
          distance = nextDistance;
        }
      }
      return line;
    }

    function renderDocWidgetObjects() {
      clearDocWidgetChrome();
      if (state.mode !== "doc") return;
      dom.stage.querySelectorAll('[data-node-id][data-node-type]').forEach(function (widgetEl) {
        const nodeId = rawNodeId(widgetEl.getAttribute("data-node-id") || "");
        const info = state.nodeIndex.get(nodeId);
        if (!info || !isDocModeObject(info.node)) return;
        widgetEl._fmdeDocBaseTransform = widgetEl.style.transform || "";
        if (!widgetEl._fmdeDocWidgetPointerBound) {
          widgetEl._fmdeDocWidgetPointerBound = true;
          widgetEl.addEventListener("pointerdown", function (event) {
            if (event.button !== 0) return;
            const interactive = event.target.closest("input,textarea,select,option,button,a,video,audio,canvas");
            const editableText = event.target.closest('[contenteditable="true"]');
            const selectionId = groupAncestorId(nodeId) || nodeId;
            const additive = event.shiftKey || event.ctrlKey || event.metaKey;
            const alreadySelected = state.selection.indexOf(selectionId) !== -1;
            if (additive) {
              const next = alreadySelected
                ? state.selection.filter(function (id) { return id !== selectionId; })
                : state.selection.concat([selectionId]);
              setSelection(next);
              // Modifier-click is a selection gesture, never the beginning of
              // a drag. This makes both Ctrl/Cmd and Shift reliable toggles.
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (!alreadySelected) setSelection([selectionId]);
            state.docKeyboardObjectId = interactive || editableText ? null : selectionId;
            if (interactive || editableText) return;
            // Give a body-selected widget keyboard ownership. Without this,
            // focus can remain in the preceding contenteditable paragraph and
            // Delete edits text even though the widget chrome is selected.
            if (!editableText) {
              if (!widgetEl.hasAttribute("tabindex")) widgetEl.setAttribute("tabindex", "-1");
              try { widgetEl.focus({ preventScroll: true }); } catch (err) { widgetEl.focus(); }
            }
            event.stopPropagation();
            const selectedEl = selectionId === nodeId ? widgetEl : renderedNodeElement(selectionId);
            if (selectedEl) startDocWidgetDrag(selectionId, selectedEl, event);
          });
          widgetEl.addEventListener("dblclick", function (event) {
            if (nodeCroppable(info.node)) {
              startDocCropFromElement(widgetEl, event);
              return;
            }
            if (info.node.type !== "shape") return;
            event.preventDefault();
            event.stopPropagation();
            setSelection([nodeId]);
            startShapeTextEdit(nodeId);
          });
        }
        const selected = state.selection.indexOf(nodeId) !== -1;
        if (!selected) return;
        widgetEl.classList.add("fmde-doc-object");
        const single = state.selection.length === 1;
        const chrome = el("div", { class: "fmde-doc-object-chrome" + (single ? "" : " fmde-doc-object-chrome-member"), contenteditable: "false", "data-widget-node-id": nodeId });
        chrome._fmdeWidgetEl = widgetEl;
        applySelectionOutline(chrome, info.node);
        if (single) chrome.appendChild(widgetLayoutButtons(info.node, "fmde-doc-object-controls"));
        if (!single) {
          dom.stage.appendChild(chrome);
          positionDocWidgetChrome(chrome, widgetEl);
          return;
        }
        const axes = widgetResizeAxes(info.node);
        ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(function (direction) {
          const usesX = /[ew]/.test(direction);
          const usesY = /[ns]/.test(direction);
          const activeX = usesX && axes.x;
          const activeY = usesY && axes.y;
          const active = activeX || activeY;
          const axisClass = activeX && !activeY ? " fmde-resize-axis-x" : (activeY && !activeX ? " fmde-resize-axis-y" : "");
          const title = active ? "Resize " + (info.node.type === "widget" ? "widget" : "object") : "Height is set by widget content";
          const resize = el("span", { class: "fmde-doc-object-resize fmde-doc-resize-" + direction + axisClass + (active ? "" : " fmde-resize-locked"), title: title, contenteditable: "false", "data-resize-direction": direction, "aria-disabled": active ? "false" : "true" });
          resize.addEventListener("pointerdown", function (event) { event.preventDefault(); event.stopPropagation(); if (active) startDocWidgetResize(nodeId, widgetEl, direction, event); });
          chrome.appendChild(resize);
        });
        dom.stage.appendChild(chrome);
        positionDocWidgetChrome(chrome, widgetEl);
        if (isGroupNode(info.node)) {
          (function addGroupMemberChrome(children) {
            for (const child of children || []) {
              const childEl = renderedNodeElement(child.id);
              if (childEl) {
                const memberChrome = el("div", { class: "fmde-doc-object-chrome fmde-doc-object-group-member", contenteditable: "false", "data-group-member-node-id": child.id });
                memberChrome._fmdeWidgetEl = childEl;
                applySelectionOutline(memberChrome, child);
                dom.stage.appendChild(memberChrome);
                positionDocWidgetChrome(memberChrome, childEl);
              }
              addGroupMemberChrome(child.children);
            }
          })(info.node.children);
        }
      });
    }

    function startDocWidgetResize(nodeId, widgetEl, direction, downEvent) {
      const info = state.nodeIndex.get(nodeId);
      if (!info || !nodeResizable(info.node)) return;
      // The selected node is replaced when the resize commits. Keep keyboard
      // focus on the persistent editor root so Ctrl+Z is not lost to <body>
      // immediately after that render.
      try { dom.root.focus({ preventScroll: true }); } catch (err) { dom.root.focus(); }
      const axes = widgetResizeAxes(info.node);
      const useW = axes.x && direction.indexOf("w") !== -1;
      const useE = axes.x && direction.indexOf("e") !== -1;
      const useN = axes.y && direction.indexOf("n") !== -1;
      const useS = axes.y && direction.indexOf("s") !== -1;
      if (!useW && !useE && !useN && !useS) return;
      const layout = widgetLayoutMode(info.node);
      const freelyPositioned = layout === "front" || layout === "behind";
      const measured = gestureFrame(info.node);
      const rect = widgetEl.getBoundingClientRect();
      const widgetConfig = info.node.props && info.node.props.config || {};
      const flowOffsetX = num(widgetConfig._fm_flow_resize_offset_x, 0);
      const flowOffsetY = num(widgetConfig._fm_flow_resize_offset_y, 0);
      const snapLines = docWidgetSnapLines(widgetEl, [nodeId]);
      const pxPerPt = PX_PER_PT * state.zoom;
      const start = {
        clientX: downEvent.clientX,
        clientY: downEvent.clientY,
        x: freelyPositioned ? num(measured.x, num(info.node.frame && info.node.frame.x, 0)) : flowOffsetX,
        y: freelyPositioned ? num(measured.y, num(info.node.frame && info.node.frame.y, 0)) : flowOffsetY,
        w: rect.width / PX_PER_PT / state.zoom,
        h: rect.height / PX_PER_PT / state.zoom
      };
      let last = null;
      trackPointer(downEvent, function (event) {
        const dx = (event.clientX - start.clientX) / PX_PER_PT / state.zoom;
        const dy = (event.clientY - start.clientY) / PX_PER_PT / state.zoom;
        let w = useW ? Math.max(MIN_NODE_SIZE_PT, start.w - dx) : (useE ? Math.max(MIN_NODE_SIZE_PT, start.w + dx) : start.w);
        let h = useN ? Math.max(MIN_NODE_SIZE_PT, start.h - dy) : (useS ? Math.max(MIN_NODE_SIZE_PT, start.h + dy) : start.h);
        const snap = { vLine: null, hLine: null };
        if (snapLines && !event.altKey) {
          const xEdge = useW ? rect.right - w * pxPerPt : (useE ? rect.left + w * pxPerPt : null);
          const yEdge = useN ? rect.bottom - h * pxPerPt : (useS ? rect.top + h * pxPerPt : null);
          if (xEdge !== null) {
            snap.vLine = nearestDocWidgetSnap(xEdge, snapLines.v);
            if (snap.vLine !== null) {
              const snappedW = (useW ? rect.right - snap.vLine : snap.vLine - rect.left) / pxPerPt;
              if (snappedW >= MIN_NODE_SIZE_PT) w = snappedW;
              else snap.vLine = null;
            }
          }
          if (yEdge !== null) {
            snap.hLine = nearestDocWidgetSnap(yEdge, snapLines.h);
            if (snap.hLine !== null) {
              const snappedH = (useN ? rect.bottom - snap.hLine : snap.hLine - rect.top) / pxPerPt;
              if (snappedH >= MIN_NODE_SIZE_PT) h = snappedH;
              else snap.hLine = null;
            }
          }
          showDocWidgetGuides(snapLines, snap);
        } else clearDocWidgetGuides();
        // Paint the same rounded geometry that pointer-up will commit. Keeping
        // extra sub-point precision here made thick borders/radii shift by a
        // fraction of a pixel as soon as the mouse was released.
        last = {
          x: roundPt(useW ? start.x + (start.w - w) : start.x),
          y: roundPt(useN ? start.y + (start.h - h) : start.y),
          w: roundPt(w),
          h: roundPt(h)
        };
        widgetEl.style.width = last.w + "pt";
        widgetEl.style.height = last.h + "pt";
        // Doc-mode page objects do not use liveSetFrame. Keep an image-filled
        // shape's SVG viewBox and pattern geometry in step with the outer box
        // here too, otherwise the browser stretches the stale SVG until the
        // pointer-up render.
        if (info.node.type === "shape" && root.FMDocRenderer && typeof root.FMDocRenderer.syncShapeSvg === "function") {
          const svg = widgetEl.querySelector("svg");
          if (svg) {
            try { root.FMDocRenderer.syncShapeSvg(svg, info.node, last.w, last.h); } catch (err) { /* live preview only */ }
          }
        }
        // A west/north handle moves that edge; merely changing width/height
        // keeps the leading edge fixed and makes the opposite edge move.
        if (useW) widgetEl.style.left = last.x + "pt";
        if (useN) widgetEl.style.top = last.y + "pt";
        positionDocWidgetControls();
      }, function () {
        clearDocWidgetGuides();
        if (!last) return;
        const frame = Object.assign({}, info.node.frame, { w: roundPt(last.w), h: roundPt(last.h) });
        const commands = [{ type: "node.set", node_id: nodeId, prop: "frame", value: frame }];
        if (freelyPositioned) {
          frame.x = roundPt(last.x);
          frame.y = roundPt(last.y);
        } else {
          if (useW) commands.push({ type: "node.set", node_id: nodeId, prop: "props.config._fm_flow_resize_offset_x", value: roundPt(last.x) });
          if (useN) commands.push({ type: "node.set", node_id: nodeId, prop: "props.config._fm_flow_resize_offset_y", value: roundPt(last.y) });
        }
        runCommands(commands, "widget-resize");
      });
    }

    function startDocWidgetDrag(nodeId, widgetEl, downEvent) {
      const info = state.nodeIndex.get(nodeId);
      if (!info || !nodeMovable(info.node)) return;
      const mode = widgetLayoutMode(info.node);
      const start = { x: downEvent.clientX, y: downEvent.clientY };
      const startRect = widgetEl.getBoundingClientRect();
      const snapLines = mode === "front" || mode === "behind" ? docWidgetSnapLines(widgetEl, state.selection) : null;
      const absoluteMovers = (mode === "front" || mode === "behind" ? state.selection : [nodeId]).map(function (id) {
        const moverInfo = state.nodeIndex.get(id);
        const moverEl = id === nodeId ? widgetEl : renderedNodeElement(id);
        const moverMode = moverInfo && widgetLayoutMode(moverInfo.node);
        return moverInfo && moverEl && nodeMovable(moverInfo.node) && (moverMode === "front" || moverMode === "behind")
          ? { id: id, info: moverInfo, el: moverEl, rect: moverEl.getBoundingClientRect(), baseTransform: moverEl._fmdeDocBaseTransform || moverEl.style.transform || "" }
          : null;
      }).filter(Boolean);
      const movers = absoluteMovers.length ? absoluteMovers : [{ id: nodeId, info: info, el: widgetEl, rect: widgetEl.getBoundingClientRect(), baseTransform: widgetEl._fmdeDocBaseTransform || "" }];
      const startSnapRect = movers.reduce(function (combined, mover) {
        const rect = mover.rect;
        if (!combined) return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
        const right = Math.max(combined.x + combined.w, rect.right);
        const bottom = Math.max(combined.y + combined.h, rect.bottom);
        combined.x = Math.min(combined.x, rect.left);
        combined.y = Math.min(combined.y, rect.top);
        combined.w = right - combined.x;
        combined.h = bottom - combined.y;
        return combined;
      }, null) || { x: startRect.left, y: startRect.top, w: startRect.width, h: startRect.height };
      let lastEvent = downEvent;
      let lastDelta = { x: 0, y: 0 };
      let moved = false;
      trackPointer(downEvent, function (event) {
        let dxPx = event.clientX - start.x;
        let dyPx = event.clientY - start.y;
        if (!moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
        if (!moved) {
          moved = true;
          movers.forEach(function (mover) { mover.el.classList.add("fmde-doc-object-dragging"); });
        }
        event.preventDefault();
        lastEvent = event;
        if (snapLines && !event.altKey) {
          const snapBounds = { x: startSnapRect.x + dxPx, y: startSnapRect.y + dyPx, w: startSnapRect.w, h: startSnapRect.h };
          const snap = applyEqualSpacingSnap(snapAdjust(snapBounds, snapLines, SNAP_TOLERANCE_PX), snapBounds, snapLines.boxes, SNAP_TOLERANCE_PX);
          dxPx += snap.dx; dyPx += snap.dy;
          showDocWidgetGuides(snapLines, snap);
        } else clearDocWidgetGuides();
        lastDelta = { x: dxPx, y: dyPx };
        movers.forEach(function (mover) {
          mover.el.style.transform = (mover.baseTransform ? mover.baseTransform + " " : "") + "translate(" + dxPx + "px," + dyPx + "px)";
        });
        positionDocWidgetControls();
      }, function () {
        movers.forEach(function (mover) {
          mover.el.classList.remove("fmde-doc-object-dragging");
          mover.el.style.transform = mover.baseTransform;
        });
        clearDocWidgetGuides();
        positionDocWidgetControls();
        if (!moved) return;
        widgetEl.addEventListener("click", function suppressDragClick(event) { event.preventDefault(); event.stopPropagation(); }, { capture: true, once: true });
        if (mode === "front" || mode === "behind") {
          const pages = pageElements();
          let destinationPage = null;
          for (const pageEl of pages) {
            const rect = pageEl.getBoundingClientRect();
            if (lastEvent.clientX >= rect.left && lastEvent.clientX <= rect.right && lastEvent.clientY >= rect.top && lastEvent.clientY <= rect.bottom) {
              const pageId = rawNodeId(pageEl.getAttribute("data-page-id") || "");
              if (M.findPage(state.doc, pageId)) destinationPage = { el: pageEl, id: pageId, rect: rect };
            }
          }
          const commands = movers.map(function (mover) {
            const targetPageId = destinationPage ? destinationPage.id : mover.info.pageId;
            const targetPageEl = destinationPage ? destinationPage.el : (pageElements().find(function (pageEl) { return rawNodeId(pageEl.getAttribute("data-page-id") || "") === mover.info.pageId; }) || null);
            const targetRect = destinationPage ? destinationPage.rect : (targetPageEl && targetPageEl.getBoundingClientRect());
            let x = num(mover.info.node.frame && mover.info.node.frame.x, 0) + lastDelta.x / PX_PER_PT / state.zoom;
            let y = num(mover.info.node.frame && mover.info.node.frame.y, 0) + lastDelta.y / PX_PER_PT / state.zoom;
            if (targetRect && targetRect.width && targetRect.height) {
              const paper = dims();
              x = (mover.rect.left + lastDelta.x - targetRect.left) * paper.w_pt / targetRect.width;
              y = (mover.rect.top + lastDelta.y - targetRect.top) * paper.h_pt / targetRect.height;
            }
            const frame = Object.assign({}, mover.info.node.frame, { x: roundPt(x), y: roundPt(y), z: Math.max(0, num(mover.info.node.frame && mover.info.node.frame.z, 0)), layout: "absolute" });
            if (targetPageId && targetPageId !== mover.info.pageId) return { type: "node.move", node_id: mover.id, parent_id: null, page_id: targetPageId, frame: frame };
            return { type: "node.set", node_id: mover.id, prop: "frame", value: frame };
          });
          runCommands(commands, "widget-move");
          return;
        }
        const targetEl = document.elementFromPoint(lastEvent.clientX, lastEvent.clientY);
        const targetNodeEl = targetEl && targetEl.closest && targetEl.closest("[data-node-id]");
        const targetId = targetNodeEl ? rawNodeId(targetNodeEl.getAttribute("data-node-id") || "") : "";
        const target = state.nodeIndex.get(targetId);
        if (target && target.parentId === info.parentId && targetId !== nodeId) runCommands([{ type: "node.move", node_id: nodeId, parent_id: info.parentId, index: target.index }], "widget-reorder");
      });
    }

    function colorRgb(value) {
      const text = String(value || "").trim();
      const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        const body = hex[1].length === 3 ? hex[1].split("").map(function (c) { return c + c; }).join("") : hex[1];
        return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
      }
      const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
      return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
    }

    function colorLuminance(rgb) {
      const values = rgb.map(function (value) {
        const normalized = Math.max(0, Math.min(255, value)) / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    }

    function colorContrast(a, b) {
      const la = colorLuminance(a);
      const lb = colorLuminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    function selectionOutline(node) {
      const accent = colorRgb(root.getComputedStyle ? root.getComputedStyle(dom.root).getPropertyValue("--fmde-accent") : "") || [37, 99, 235];
      const fill = node && node.style && node.style.fill;
      const background = colorRgb(nodeBackgroundColor(node)) || [255, 255, 255];
      const uncertain = !!(fill && fill.type === "image");
      if (!uncertain && colorContrast(accent, background) >= 3) return { color: "rgb(" + accent.join(",") + ")", halo: colorLuminance(background) > 0.5 ? "rgba(255,255,255,.72)" : "rgba(15,23,42,.6)" };
      const white = [255, 255, 255];
      const black = [15, 23, 42];
      const lightWins = uncertain || colorContrast(white, background) >= colorContrast(black, background);
      return lightWins ? { color: "#ffffff", halo: "rgba(15,23,42,.72)" } : { color: "#0f172a", halo: "rgba(255,255,255,.82)" };
    }

    function applySelectionOutline(boxEl, node) {
      const outline = selectionOutline(node);
      boxEl.style.setProperty("--fmde-selection-color", outline.color);
      boxEl.style.setProperty("--fmde-selection-halo", outline.halo);
    }

    /** The website root paints the whole canvas, including header/footer
     *  previews and authoring gutters. Its selection outline must describe
     *  that same surface instead of the smaller rendered root node. */
    function positionViewRootSelection() {
      if (!dom.canvas) return;
      const box = dom.canvas.querySelector(":scope > .fmde-view-root-selbox");
      if (!box) return;
      const inset = 4;
      box.style.left = (dom.canvas.scrollLeft + inset) + "px";
      box.style.top = (dom.canvas.scrollTop + inset) + "px";
      box.style.width = Math.max(0, dom.canvas.clientWidth - inset * 2) + "px";
      box.style.height = Math.max(0, dom.canvas.clientHeight - inset * 2) + "px";
    }

    function drawViewRootSelection() {
      if (!isViewDoc() || state.mode !== "visual" || state.selection.length !== 1 || !state.doc.root || state.selection[0] !== state.doc.root.id) return false;
      const box = el("div", {
        class: "fmde-selbox single fmde-view-root-selbox",
        "data-fmde-selbox": state.doc.root.id,
        style: { zIndex: "610" }
      });
      applySelectionOutline(box, state.doc.root);
      dom.canvas.appendChild(box);
      state.selBoxes.set(state.doc.root.id, box);
      positionViewRootSelection();
      return true;
    }

    function drawSelection() {
      state.selBoxes = new Map();
      for (const old of Array.prototype.slice.call(dom.canvas.querySelectorAll(":scope > .fmde-view-root-selbox"))) old.remove();
      for (const entry of state.pageEntries) {
        entry.boxes.innerHTML = "";
        updateOverlayMetrics(entry);
      }
      positionDocWidgetControls();
      if (state.profile === "fill" || !state.selection.length) {
        positionPopover();
        return;
      }
      if (drawViewRootSelection()) {
        positionPopover();
        return;
      }
      const byPage = {};
      for (const id of state.selection) {
        const box = overlayBox(id);
        if (!box || !box.pageId) continue;
        if (!byPage[box.pageId]) byPage[box.pageId] = [];
        byPage[box.pageId].push({ id: id, box: box });
      }
      const single = state.selection.length === 1;
      for (const pageId of Object.keys(byPage)) {
        const entry = entryForPage(pageId);
        if (!entry) continue;
        const items = byPage[pageId];
        for (const item of items) {
          const info = state.nodeIndex.get(item.id);
          const node = info ? info.node : null;
          const boxEl = el("div", {
            class: "fmde-selbox" + (single ? " single" : " member"),
            "data-fmde-selbox": item.id,
            style: {
              left: item.box.x + "pt",
              top: item.box.y + "pt",
              width: Math.max(0, item.box.w) + "pt",
              height: Math.max(0, item.box.h) + "pt",
              transform: item.box.rotation ? "rotate(" + item.box.rotation + "deg)" : ""
            }
          });
          applySelectionOutline(boxEl, node);
          if (single && node) {
            if (nodeResizable(node)) {
              const resizeDirections = isStructuralSection(item.id) ? ["n", "s", "e", "w"] : HANDLE_DIRS;
              for (const dir of resizeDirections) {
                boxEl.appendChild(el("span", { class: "fmde-handle fmde-handle-" + dir, "data-fmde-handle": dir }));
              }
            }
            if (nodeRotatable(node)) {
              boxEl.appendChild(el("span", { class: "fmde-handle-rotate", "data-fmde-handle": "rotate", html: iconSvg("redo") }));
            }
            if (node.type === "widget") boxEl.appendChild(widgetLayoutButtons(node));
            // v2: component instances carry a name badge on their selection box.
            const compName = node.type === "component_ref" ? (node.props && node.props.component) :
              node.type === "repeater" ? (node.props && node.props.component) : node.component;
            if (compName) {
              const detached = node.type === "component_ref" && node.props && node.props.detached;
              boxEl.appendChild(el("span", { class: "fmde-compbadge", text: String(compName) + (detached ? " (detached)" : "") }));
            }
          }
          entry.boxes.appendChild(boxEl);
          state.selBoxes.set(item.id, boxEl);
          if (single && isGroupNode(node)) {
            (function addMembers(children) {
              for (const child of children || []) {
                const childBox = overlayBox(child.id);
                if (childBox && childBox.pageId === pageId) {
                  const memberBox = el("div", {
                    class: "fmde-selbox group-member",
                    "data-fmde-group-member": child.id,
                    style: {
                      left: childBox.x + "pt", top: childBox.y + "pt",
                      width: Math.max(0, childBox.w) + "pt", height: Math.max(0, childBox.h) + "pt",
                      transform: childBox.rotation ? "rotate(" + childBox.rotation + "deg)" : ""
                    }
                  });
                  applySelectionOutline(memberBox, child);
                  entry.boxes.appendChild(memberBox);
                }
                addMembers(child.children);
              }
            })(node.children);
          }
        }
        if (!single && items.length > 1) {
          // Multi-selection: shared bounding box with resize handles
          // (transforms apply per node — v1 simplification).
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const item of items) {
            const b = M.frameBounds({ x: item.box.x, y: item.box.y, w: item.box.w, h: item.box.h, rotation: item.box.rotation });
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.w);
            maxY = Math.max(maxY, b.y + b.h);
          }
          const groupBox = el("div", {
            class: "fmde-selbox multi",
            style: { left: minX + "pt", top: minY + "pt", width: (maxX - minX) + "pt", height: (maxY - minY) + "pt" }
          });
          applySelectionOutline(groupBox, items[0] && state.nodeIndex.get(items[0].id) ? state.nodeIndex.get(items[0].id).node : null);
          if (can("resize")) {
            for (const dir of HANDLE_DIRS) {
              groupBox.appendChild(el("span", { class: "fmde-handle fmde-handle-" + dir, "data-fmde-handle": dir }));
            }
          }
          entry.boxes.appendChild(groupBox);
          state.selBoxes.set("__multi__" + pageId, groupBox);
        }
      }
      positionPopover();
    }

    function setSelection(ids, options) {
      const next = [];
      for (const id of ids || []) {
        let selectionId = id;
        if (state.mode === "visual") {
          const chain = ancestorChain(id);
          for (const ancestorId of chain) {
            const ancestor = state.nodeIndex.get(ancestorId);
            if (ancestor && isDocumentBodyFrame(ancestor.node)) {
              selectionId = ancestorId;
              break;
            }
          }
        }
        if (state.nodeIndex.has(selectionId) && next.indexOf(selectionId) === -1) next.push(selectionId);
      }
      const changed = next.length !== state.selection.length || next.some(function (id, i) { return state.selection[i] !== id; });
      state.selection = next;
      if (!next.length || next.indexOf(state.docKeyboardObjectId) === -1) state.docKeyboardObjectId = null;
      if (next.length) state.selectedPageId = null;
      // Selecting something on the canvas pulls the tabbed tray back to
      // Inspect so the node's controls are what the user sees.
      if (changed && next.length && state.sidePanels.length && state.mode === "visual" && state.activeInspTab !== "inspect") {
        state.activeInspTab = "inspect";
      }
      const selectedInfo = next.length === 1 ? state.nodeIndex.get(next[0]) : null;
      const selectedWidget = !!(selectedInfo && selectedInfo.node && selectedInfo.node.type === "widget");
      const selectedTable = !!(selectedInfo && selectedInfo.node && selectedInfo.node.type === "table");
      if (selectedTable) state.activeInspTab = "table";
      else if (state.activeInspTab === "table") state.activeInspTab = state.mode === "visual" ? "inspect" : (state.sidePanels[0] ? String(state.sidePanels[0].id) : "inspect");
      if (selectedWidget && state.inspectorCollapsed) {
        state.inspectorAutoOpened = true;
        setSideCollapsed("inspector", false, { automatic: true, temporary: true });
      } else if (!selectedWidget && state.inspectorAutoOpened) {
        setSideCollapsed("inspector", true, { automatic: true, temporary: true });
        state.inspectorAutoOpened = false;
      }
      drawSelection();
      if (changed && state.mode === "doc") renderDocWidgetObjects();
      updateToolbarState();
      if (!options || !options.keepInspector) renderInspector();
      if (changed) emitSelection();
    }

    function clearDocObjectSelectionForText() {
      if (state.mode !== "doc") return;
      state.docKeyboardObjectId = null;
      if (state.selection.length) setSelection([], { keepInspector: true });
    }

    function emitSelection() {
      const ids = state.selection.slice();
      emit("selection", ids);
      if (typeof opts.onSelect === "function") {
        try { opts.onSelect(ids); } catch (err) { if (root && root.console) root.console.error("[FMDocEditor] onSelect error", err); }
      }
    }

    function selectedNodes() {
      return state.selection
        .map(function (id) { return state.nodeIndex.get(id); })
        .filter(Boolean)
        .map(function (info) { return info.node; });
    }

    // ---- zoom --------------------------------------------------------------------------

    function computeFitZoom(mode) {
      const paper = dims();
      // View docs with an active viewport constraint (mobile preview): the
      // stage renders at exactly that CSS pixel width, mirroring how the site
      // runtime scales the live page.
      if (isViewDoc() && state.viewportWidth) {
        // Fluid pages reflow into the constrained viewport instead of scaling.
        if (viewIsFill()) return 1;
        // min(1, …) mirrors the site runtime, which never magnifies.
        return Math.min(1, state.viewportWidth / (viewDesignWidthPt() * PX_PER_PT));
      }
      // Fluid pages already span the canvas — fitting is a no-op at 100%.
      if (viewIsFill()) return 1;
      const pad = 96;
      const availW = Math.max(120, dom.canvas.clientWidth - pad);
      // View docs fit against their actual design width (the root frame may
      // be wider than settings.paper); paged docs keep the paper width.
      const wZoom = availW / ((isViewDoc() ? viewDesignWidthPt() : paper.w_pt) * PX_PER_PT);
      // Auto-fit never magnifies past 100%: portrait pages on wide monitors
      // would otherwise open at ~180% and show half a page. Manual zoom (the
      // +/- controls, Ctrl+wheel) can still exceed 1.
      if (mode === "fit-page") {
        const availH = Math.max(120, dom.canvas.clientHeight - pad);
        return Math.min(1, wZoom, availH / (paper.h_pt * PX_PER_PT));
      }
      return Math.min(1, wZoom);
    }

    /** View docs only (contracts §10): constrain the stage to a CSS pixel
     *  width and rescale — the mobile-preview surface. null restores auto
     *  fit-width. Emits "viewport". */
    function setViewportWidth(px) {
      if (!isViewDoc()) return null;
      const width = Number(px);
      state.viewportWidth = Number.isFinite(width) && width > 0 ? width : null;
      setZoom("fit-width");
      emit("viewport", state.viewportWidth);
      return state.viewportWidth;
    }

    /** Fluid pages don't scale for the mobile preview — the stage itself is
     *  constrained to the viewport width so content reflows, like the live
     *  site. Fixed-width pages keep the scale-down behavior. */
    function syncStageViewport() {
      const constrained = viewIsFill() && state.viewportWidth;
      dom.stage.style.width = constrained ? state.viewportWidth + "px" : "";
      dom.stage.style.marginLeft = constrained ? "auto" : "";
      dom.stage.style.marginRight = constrained ? "auto" : "";
    }

    /** The authored website surface is inset while editing so handles have
     *  breathing room, but Preview is the real website viewport and must use
     *  every available pixel. Keeping this calculation in one place prevents
     *  headers and body sections from acquiring different center axes. */
    function currentViewSurfaceWidth() {
      const authoringGutter = state.mode === "preview" ? 0 : 96;
      return Math.max(120, state.viewportWidth || (dom.canvas.clientWidth - authoringGutter));
    }

    function setZoom(value) {
      // The public handle doubles as a getter for the visual editor's zoom
      // readout. A getter call must not turn off fit-width: doing so froze the
      // old scale when editor rails or trays subsequently changed the visible
      // canvas width.
      if (arguments.length === 0 || value === undefined) return state.zoom;
      if (Number.isFinite(state.zoomLock)) value = state.zoomLock;
      syncStageViewport();
      if (value === "fit-width" || value === "fit-page" || value === "fit") {
        const mode = value === "fit" ? "fit-page" : value;
        state.fitMode = mode;
        state.zoom = clamp(computeFitZoom(mode), MIN_ZOOM, MAX_ZOOM);
      } else {
        const z = num(value, state.zoom);
        state.fitMode = null;
        state.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
      }
      // Scale-only fast path: retransform the existing render instead of a
      // full async rebuild — keeps zooming instant and the overlays live.
      if (state.renderHandle && typeof state.renderHandle.setScale === "function" && !state.renderError) {
        state.renderHandle.setScale(state.zoom);
        if (isViewDoc() && typeof state.renderHandle.setViewSurfaceWidth === "function") {
          state.renderHandle.setViewSurfaceWidth(currentViewSurfaceWidth());
        }
        for (const entry of state.pageEntries) updateOverlayMetrics(entry);
        drawSelection();
      } else {
        renderCanvas();
      }
      updateToolbarState();
      return state.zoom;
    }

    /** Temporarily make the host the sole owner of visual scaling. Passing a
     *  finite value locks every editor zoom path to it; null releases it. */
    function setZoomLock(value) {
      const next = Number(value);
      state.zoomLock = value !== null && value !== undefined && Number.isFinite(next)
        ? clamp(next, MIN_ZOOM, MAX_ZOOM)
        : null;
      if (Number.isFinite(state.zoomLock)) setZoom(state.zoomLock);
      return state.zoomLock;
    }

    function onCanvasWheel(ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(state.zoom * factor);
    }

    let resizeObserver = null;
    const onViewportResize = debounce(function () {
      if (state.destroyed) return;
      fitDocToolbar();
      if (state.fitMode) setZoom(state.fitMode);
      else {
        if (isViewDoc() && state.renderHandle && typeof state.renderHandle.setViewSurfaceWidth === "function") {
          state.renderHandle.setViewSurfaceWidth(currentViewSurfaceWidth());
        }
        drawSelection();
      }
    }, 150);

    // ---- hit testing ---------------------------------------------------------------------

    /** Topmost top-level node of a page at a point (pt). When a frame has been
     *  "entered" (double-click), its children are hit-tested in local space. */
    // ---- view authoring model: sections stack, contents are absolute ---------------------------

    /** Website/portal pages are authored like Canva/Wix: sections stack down the
     *  page and everything INSIDE a section is absolutely positioned, so it can
     *  be clicked, dragged, resized and rotated. Generated + legacy pages are
     *  laid out with flexbox flow, which is great for authoring content but
     *  impossible to direct-manipulate (the renderer ignores frame.x/y and
     *  rotation for flow children). This freezes the flow result into absolute
     *  geometry using the REAL rendered measurements, so it is pixel-identical
     *  and runs once per page. */
    function viewSections() {
      const rootNode = state.doc.root;
      if (!rootNode || !Array.isArray(rootNode.children)) return [];
      // Only expose the variant that is currently painted.  In particular,
      // insertion/hit-testing in the phone preview must target the independent
      // mobile section rather than its hidden desktop source.
      if (typeof M.activeViewSections === "function") {
        return M.activeViewSections(state.doc, state.viewportWidth && state.viewportWidth <= 600 ? "mobile" : "desktop");
      }
      return rootNode.children;
    }

    function viewNeedsNormalize() {
      if (!isViewDoc() || !state.doc.root) return false;
      for (const section of viewSections()) {
        const kids = Array.isArray(section.children) ? section.children : [];
        if (!kids.length) continue;
        if (((section.frame || {}).layout) !== "absolute") return true;
        for (const kid of kids) {
          const kf = kid.frame || {};
          if (typeof kf.w !== "number" || typeof kf.h !== "number" ||
              typeof kf.x !== "number" || typeof kf.y !== "number") return true;
        }
      }
      return false;
    }

    /** Measure-and-freeze. Returns true when the document was rewritten. */
    function normalizeViewLayout() {
      if (!viewNeedsNormalize()) return false;
      const plan = [];
      for (const section of viewSections()) {
        const box = overlayBox(section.id);
        if (!box || !Number.isFinite(box.w) || !box.w) return false; // not rendered yet
        const kids = Array.isArray(section.children) ? section.children : [];
        const kidBoxes = [];
        for (const kid of kids) {
          const kb = overlayBox(kid.id);
          if (!kb || !Number.isFinite(kb.w)) return false;
          kidBoxes.push(kb);
        }
        plan.push({ section: section, box: box, kids: kids, kidBoxes: kidBoxes });
      }
      if (!plan.length) return false;
      const nextRoot = M.deepClone(state.doc.root);
      const byId = new Map();
      (function collect(node, depth) {
        if (!node || depth > 64) return;
        if (node.id) byId.set(node.id, node);
        const kids = Array.isArray(node.children) ? node.children : [];
        for (const kid of kids) collect(kid, depth + 1);
      })(nextRoot, 0);
      for (const item of plan) {
        const section = byId.get(item.section.id);
        if (!section) continue;
        const sf = section.frame || (section.frame = {});
        sf.layout = "absolute";
        sf.h = roundPt(item.box.h);
        // "auto" (never undefined — the DocModel schema rejects a missing w)
        // so sections keep stretching to the page width.
        sf.w = "auto";
        item.kids.forEach(function (kid, i) {
          const target = byId.get(kid.id);
          if (!target) return;
          const kb = item.kidBoxes[i];
          const kf = target.frame || (target.frame = {});
          kf.x = roundPt(kb.x - item.box.x);
          kf.y = roundPt(kb.y - item.box.y);
          kf.w = roundPt(kb.w);
          kf.h = roundPt(kb.h);
          if (typeof kf.z !== "number") kf.z = i + 1;
        });
      }
      runCommands([{ type: "doc.set", prop: "root", value: nextRoot }], "layout-normalize");
      return true;
    }

    /** Ids of the page's sections (direct children of the view root). */
    function isSectionId(nodeId) {
      for (const section of viewSections()) if (section.id === nodeId) return true;
      return false;
    }

    function isGroupNode(node) {
      return !!(node && node.type === "frame" && Array.isArray(node.children) && node.children.length &&
        ((node.props && node.props.fmde_group === true) || node.name === "Group"));
    }

    function groupAncestorId(nodeId) {
      let info = state.nodeIndex.get(rawNodeId(nodeId));
      let hops = 0;
      while (info && info.parentId && hops < 64) {
        const parent = state.nodeIndex.get(info.parentId);
        if (!parent) break;
        if (isGroupNode(parent.node)) return parent.node.id;
        info = parent;
        hops += 1;
      }
      return null;
    }

    function ancestorChain(nodeId) {
      const chain = [];
      let cur = nodeId;
      let hops = 0;
      while (cur && hops < 64) {
        chain.push(cur);
        const info = state.nodeIndex.get(cur);
        cur = info ? info.parentId : null;
        hops += 1;
      }
      return chain;
    }

    /** Canva/Wix selection policy: clicking anything inside a section selects
     *  the section-level element (so a button selects as one thing, not its
     *  label). Double-click enters a container and selects its children. */
    function promoteSelection(nodeId) {
      const chain = ancestorChain(nodeId);
      // The word-processing body is one design object. Its heading/paragraph
      // blocks remain editable in Doc mode, but Visual moves and resizes the
      // body as a whole instead of exposing each projected text fragment.
      for (let i = 0; i < chain.length; i += 1) {
        const info = state.nodeIndex.get(chain[i]);
        if (info && isDocumentBodyFrame(info.node)) return info.node.id;
      }
      for (let i = 1; i < chain.length; i += 1) {
        const info = state.nodeIndex.get(chain[i]);
        if (info && isGroupNode(info.node)) return info.node.id;
      }
      if (state.enterFrameId) {
        const idx = chain.indexOf(state.enterFrameId);
        if (idx > 0) return chain[idx - 1];
      }
      for (let i = 0; i < chain.length; i += 1) {
        if (isSectionId(chain[i])) return i === 0 ? chain[0] : chain[i - 1];
      }
      return chain[0] || nodeId;
    }

    /** Hit-test through the REAL rendered tree. Correct for nested, flow-laid
     *  out, rotated and transformed content — none of which model-frame
     *  rectangle math can handle. */
    function hitTestDom(ev) {
      const docRef = dom.root.ownerDocument || document;
      if (!docRef.elementsFromPoint) return null;
      const stack = docRef.elementsFromPoint(ev.clientX, ev.clientY) || [];
      for (const el of stack) {
        if (!el || !el.getAttribute) continue;
        if (el.getAttribute("data-chrome") === "true") continue;
        const raw = el.getAttribute("data-node-id");
        if (!raw) continue;
        const id = rawNodeId(raw);
        if (!state.nodeIndex.has(id)) continue;
        const promoted = promoteSelection(id);
        const info = state.nodeIndex.get(promoted) || state.nodeIndex.get(id);
        if (!info) continue;
        return { id: promoted, node: info.node, sourceId: id };
      }
      return null;
    }

    /** Paged documents created in Doc mode (or by the document agent) place
     * text, widgets and other content inside header/body/footer flow frames.
     * Hit-test the real rendered tree before the page-frame fallback. The
     * promotion policy keeps the Doc body atomic while still allowing objects
     * outside that body to retain normal Visual selection behavior. */
    function hitTestPagedNodeDom(ev, pageId) {
      const docRef = dom.root.ownerDocument || document;
      if (!docRef.elementsFromPoint) return null;
      const stack = docRef.elementsFromPoint(ev.clientX, ev.clientY) || [];
      for (const candidate of stack) {
        const nodeEl = candidate && candidate.closest ? candidate.closest('[data-node-id]') : null;
        if (!nodeEl || nodeEl.getAttribute("data-chrome") === "true") continue;
        const id = rawNodeId(nodeEl.getAttribute("data-node-id") || "");
        const info = state.nodeIndex.get(id);
        if (!info || info.pageId !== pageId) continue;
        const promoted = promoteSelection(id);
        const promotedInfo = state.nodeIndex.get(promoted) || info;
        return { id: promotedInfo.node.id, node: promotedInfo.node, sourceId: id };
      }
      return null;
    }

    function hitTest(pageId, pt) {
      // View docs: one synthetic page, top-level nodes live on doc.root.
      const view = isViewDoc();
      const page = view ? null : M.findPage(state.doc, pageId);
      if (!view && !page) return null;
      if (state.enterFrameId) {
        const info = state.nodeIndex.get(state.enterFrameId);
        if (info && info.pageId === pageId && info.node.type === "frame") {
          const frame = info.node.frame || {};
          if (M.pointInFrame(pt.x, pt.y, frame)) {
            let local = { x: pt.x - frame.x, y: pt.y - frame.y };
            if (frame.rotation) {
              const cx = frame.x + (frame.w || 0) / 2;
              const cy = frame.y + (frame.h || 0) / 2;
              const un = M.rotatePoint(pt.x, pt.y, cx, cy, -frame.rotation);
              local = { x: un.x - frame.x, y: un.y - frame.y };
            }
            const child = topmostAt(info.node.children || [], local);
            if (child) return child;
          } else {
            state.enterFrameId = null;
          }
        } else {
          state.enterFrameId = null;
        }
      }
      return topmostAt(view ? ((state.doc.root && state.doc.root.children) || []) : (page.page.children || []), pt);
    }

    function topmostAt(list, pt) {
      const ordered = list.slice().sort(function (a, b) {
        const za = (a.frame && a.frame.z) || 0;
        const zb = (b.frame && b.frame.z) || 0;
        if (za !== zb) return zb - za;
        return list.indexOf(b) - list.indexOf(a);
      });
      for (const node of ordered) {
        if (node.visible === false) continue;
        if (node.frame && M.pointInFrame(pt.x, pt.y, node.frame)) return { id: node.id, node: node };
      }
      return null;
    }

    // ---- snapping --------------------------------------------------------------------------

    /** Alignment guides, in PAGE space. Every visible element contributes its
     *  leading edge, centre and trailing edge on both axes — aligning with the
     *  start or end of any other element is the point of snapping, so this
     *  walks the whole page, not just top-level siblings. */
    function collectSnapLines(pageId, excludeIds) {
      const entry = entryForPage(pageId);
      const paper = dims();
      const pageW = entry && entry.w_pt ? entry.w_pt : paper.w_pt;
      const pageH = entry && entry.h_pt ? entry.h_pt : paper.h_pt;
      const v = [0, pageW / 2, pageW];
      const h = [0, pageH / 2, pageH];
      const boxes = [];
      const skip = new Set(excludeIds || []);
      // Descendants of a moving node must not act as guides for it.
      for (const id of excludeIds || []) {
        const info = state.nodeIndex.get(id);
        if (!info) continue;
        (function mark(node) {
          for (const child of (node.children || [])) { skip.add(child.id); mark(child); }
        })(info.node);
      }
      const roots = isViewDoc()
        ? ((state.doc.root && state.doc.root.children) || [])
        : (function () { const p = M.findPage(state.doc, pageId); return p ? (p.page.children || []) : []; })();
      const visit = function (node) {
        if (!node || node.visible === false) return;
        if (!skip.has(node.id)) {
          const box = overlayBox(node.id);
          if (box && Number.isFinite(box.x) && Number.isFinite(box.w)) {
            v.push(box.x, box.x + box.w / 2, box.x + box.w);
            h.push(box.y, box.y + box.h / 2, box.y + box.h);
            const bounds = M.frameBounds({ x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation });
            boxes.push({ id: node.id, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
          }
        }
        for (const child of (node.children || [])) visit(child);
      };
      for (const node of roots) visit(node);
      return { v: v, h: h, boxes: boxes };
    }

    /** Nearest guide within tolerance, else null. */
    function nearestLine(lines, value, tolerancePt) {
      let best = null;
      let bestAbs = tolerancePt + 1;
      for (const line of lines) {
        const delta = Math.abs(line - value);
        if (delta <= tolerancePt && delta < bestAbs) { best = line; bestAbs = delta; }
      }
      return best;
    }

    function snapAdjust(bounds, lines, tolerancePt) {
      const edgesV = [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w];
      const edgesH = [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h];
      let best = { dx: 0, dy: 0, vLine: null, hLine: null, dvAbs: tolerancePt + 1, dhAbs: tolerancePt + 1 };
      for (const line of lines.v) {
        for (const edge of edgesV) {
          const delta = line - edge;
          if (Math.abs(delta) <= tolerancePt && Math.abs(delta) < best.dvAbs) {
            best.dx = delta; best.vLine = line; best.dvAbs = Math.abs(delta);
          }
        }
      }
      for (const line of lines.h) {
        for (const edge of edgesH) {
          const delta = line - edge;
          if (Math.abs(delta) <= tolerancePt && Math.abs(delta) < best.dhAbs) {
            best.dy = delta; best.hLine = line; best.dhAbs = Math.abs(delta);
          }
        }
      }
      return best;
    }

    function applyEqualSpacingSnap(snap, bounds, boxes, tolerance) {
      const spacing = equalSpacingSnap(Object.assign({}, bounds, { y: bounds.y + snap.dy }), boxes, tolerance);
      if (!spacing || Math.abs(spacing.dx) > snap.dvAbs) return snap;
      snap.dx = spacing.dx;
      snap.dvAbs = Math.abs(spacing.dx);
      snap.vLine = null;
      snap.equalGap = spacing;
      return snap;
    }

    function showGuides(entry, snap) {
      entry.guides.innerHTML = "";
      if (snap.vLine !== null) {
        entry.guides.appendChild(el("div", { class: "fmde-guide fmde-guide-v", style: { left: snap.vLine + "pt" } }));
      }
      if (snap.hLine !== null) {
        entry.guides.appendChild(el("div", { class: "fmde-guide fmde-guide-h", style: { top: snap.hLine + "pt" } }));
      }
      if (snap.equalGap) {
        entry.guides.appendChild(el("div", {
          class: "fmde-guide fmde-guide-gap",
          style: {
            left: snap.equalGap.startX + "pt",
            top: snap.equalGap.y + "pt",
            width: Math.max(0, snap.equalGap.endX - snap.equalGap.startX) + "pt"
          }
        }));
        entry.guides.appendChild(el("div", {
          class: "fmde-guide fmde-guide-gap fmde-guide-gap-reference",
          style: {
            left: snap.equalGap.referenceStartX + "pt",
            top: snap.equalGap.referenceY + "pt",
            width: Math.max(0, snap.equalGap.referenceEndX - snap.equalGap.referenceStartX) + "pt"
          }
        }));
      }
    }

    function clearGuides() {
      for (const entry of state.pageEntries) entry.guides.innerHTML = "";
    }

    // ---- live (mid-gesture) node positioning ------------------------------------------------

    /** Page-space origin of a node's PARENT. frame.x/y are parent-relative but
     *  overlays live in page space; without this the selection box jumps to the
     *  parent's origin (0,0 for a section) the moment a gesture starts. */
    function gestureOrigin(nodeId) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info || !info.parentId) return { x: 0, y: 0 };
      const parentBox = overlayBox(info.parentId);
      if (!parentBox || !Number.isFinite(parentBox.x)) return { x: 0, y: 0 };
      return { x: parentBox.x, y: parentBox.y };
    }

    /** True when the node is laid out by its parent's flow (a page section),
     *  where left/top are meaningless and would visually shift it. */
    function isFlowChild(nodeId) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info || !info.parentId) return false;
      if (info.node && info.node.anchor === "page") return false;
      const parent = state.nodeIndex.get(info.parentId);
      const layout = parent && parent.node.frame && parent.node.frame.layout;
      return layout === "flow";
    }

    /** A view root child is a website section, not a freely layered object. */
    function isStructuralSection(nodeId) {
      if (!isViewDoc() || !state.doc || !state.doc.root) return false;
      const id = rawNodeId(nodeId);
      return (state.doc.root.children || []).some(function (child) { return child && child.id === id; });
    }

    function responsiveHorizontalParentId(nodeId, parentIdOverride) {
      if (!isViewDoc()) return null;
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      let parentId = parentIdOverride !== undefined ? parentIdOverride : info && info.parentId;
      const directParentId = parentId;
      let hops = 0;
      while (parentId && hops < 64) {
        if (isStructuralSection(parentId)) return directParentId || null;
        const parent = state.nodeIndex.get(parentId);
        parentId = parent && parent.parentId;
        hops += 1;
      }
      return null;
    }

    function responsiveHorizontalEligible(nodeId, parentIdOverride, frameOverride) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info) return false;
      // An inline/flow object can become absolute during the same gesture.
      // In that case the supplied next frame, rather than the stale anchor in
      // the index, determines whether it receives responsive placement.
      if (!frameOverride && isFlowChild(nodeId)) return false;
      if (!frameOverride && (info.node.anchor === "inline" || isObj(info.node.anchor))) return false;
      return !!responsiveHorizontalParentId(nodeId, parentIdOverride);
    }

    function responsiveParentWidthPx(parentId) {
      const parentEl = renderedNodeElement(parentId);
      if (parentEl && parentEl.clientWidth > 0) return parentEl.clientWidth;
      const parent = state.nodeIndex.get(parentId);
      const widthPt = parent && parent.node && parent.node.frame && parent.node.frame.w;
      return (typeof widthPt === "number" && widthPt > 0 ? widthPt : viewDesignWidthPt()) * PX_PER_PT;
    }

    function responsiveAuthoredParentWidthPt(parentId) {
      const parent = state.nodeIndex.get(parentId);
      const widthPt = parent && parent.node && parent.node.frame && parent.node.frame.w;
      return typeof widthPt === "number" && widthPt > 0 ? widthPt : viewDesignWidthPt();
    }

    function responsivePositionForFrame(frameValue, parentId, currentPosition) {
      const frame = M.deepClone(frameValue || {});
      const parentWidthPx = responsiveParentWidthPx(parentId);
      const leftPt = num(frame.x, 0);
      const widthPt = num(frame.w, 0);
      const current = M.normalizeHorizontalPosition(frame.position && frame.position.x || currentPosition);
      frame.position = isObj(frame.position) ? frame.position : {};
      frame.position.x = M.horizontalPositionFromLeft(leftPt * PX_PER_PT, widthPt * PX_PER_PT, parentWidthPx, current);
      return frame;
    }

    /** Convert a direct-manipulation frame from the current responsive DOM
     * space back into the stable authored parent coordinate space. */
    function authoredFrameFromResponsiveGesture(nodeId, frameValue, parentIdOverride, authoredParentWidthOverride) {
      const frame = M.deepClone(frameValue || {});
      const renderedMarker = frame.__fmde_rendered_responsive === true;
      delete frame.__fmde_rendered_responsive;
      if (!renderedMarker) return frame;
      const parentId = responsiveHorizontalParentId(nodeId, parentIdOverride);
      if (!parentId) return frame;
      const explicitWidth = Number(authoredParentWidthOverride);
      const authoredParentWidthPt = Number.isFinite(explicitWidth) && explicitWidth > 0
        ? explicitWidth
        : responsiveAuthoredParentWidthPt(parentId);
      const parentEl = renderedNodeElement(parentId);
      const renderedParentWidthPt = parentEl && parentEl.clientWidth > 0
        ? parentEl.clientWidth / PX_PER_PT
        : authoredParentWidthPt;
      if (!(authoredParentWidthPt > 0) || !(renderedParentWidthPt > 0)) return frame;
      const factor = authoredParentWidthPt / renderedParentWidthPt;
      for (const key of ["x", "y", "w", "h"]) {
        if (typeof frame[key] === "number") frame[key] = roundPt(frame[key] * factor);
      }
      return frame;
    }

    function responsiveFramePosition(nodeId, frameValue, parentIdOverride, authoredParentWidthOverride) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      const frame = authoredFrameFromResponsiveGesture(nodeId, frameValue, parentIdOverride, authoredParentWidthOverride);
      if (!info || !responsiveHorizontalEligible(nodeId, parentIdOverride, frame)) return frame;
      const responsiveResize = M.normalizeResponsiveResize && M.normalizeResponsiveResize(frame.responsive || info.node.frame && info.node.frame.responsive);
      // Auto rendering derives position directly from authored x/y/w/h. Its
      // manual mount contract remains dormant and must not reinterpret the
      // freshly converted frame against the current viewport width.
      if (responsiveResize && responsiveResize.mode === "auto") return frame;
      const parentId = responsiveHorizontalParentId(nodeId, parentIdOverride);
      const measured = measuredFrame(nodeId);
      if (typeof frame.x !== "number") frame.x = num(measured && measured.x, 0);
      if (typeof frame.w !== "number") frame.w = num(measured && measured.w, 0);
      return responsivePositionForFrame(frame, parentId, info.node.frame && info.node.frame.position && info.node.frame.position.x);
    }

    function liveSetFrame(nodeId, frame, origin, forceAbsolute) {
      const org = origin || { x: 0, y: 0 };
      // A flow child (a page section) is positioned by its parent's layout, not
      // by frame.x/y — which are 0. Moving either the element or its outline to
      // those coordinates flings them to the top of the page mid-gesture.
      const flowChild = isFlowChild(nodeId) && !forceAbsolute;
      let elNode = null;
      if (state.renderHandle && typeof state.renderHandle.nodeElement === "function") {
        try { elNode = state.renderHandle.nodeElement(nodeId); } catch (err) { elNode = null; }
      }
      if (elNode) {
        if (forceAbsolute) {
          const info = state.nodeIndex.get(rawNodeId(nodeId));
          let parentEl = null;
          if (info && info.parentId && state.renderHandle && typeof state.renderHandle.nodeElement === "function") {
            try { parentEl = state.renderHandle.nodeElement(info.parentId); } catch (err) { parentEl = null; }
          }
          if (parentEl && elNode.parentNode !== parentEl) parentEl.appendChild(elNode);
          elNode.style.position = "absolute";
        }
        if (!flowChild) {
          elNode.style.left = frame.x + "pt";
          elNode.style.top = frame.y + "pt";
          // Direct manipulation uses the frame's concrete parent-relative x.
          // Clear the renderer's responsive mounting translation until the
          // committed frame recalculates its percent/fixed offset.
          if (responsiveHorizontalEligible(nodeId, undefined, frame)) elNode.style.translate = "none";
        }
        if (typeof frame.w === "number" && !flowChild) elNode.style.width = frame.w + "pt";
        if (typeof frame.h === "number") elNode.style.height = frame.h + "pt";
        elNode.style.transform = frame.rotation ? "rotate(" + frame.rotation + "deg)" : "";
        // Website headers/footers are host-owned siblings after the editor
        // stage. Keep the renderer's scaled outer height synchronized with a
        // structural section's live DOM height so those siblings reflow on
        // every pointer move, rather than snapping into place on commit.
        if (flowChild && isStructuralSection(nodeId) && state.renderHandle && typeof state.renderHandle.syncLayoutFootprint === "function") {
          state.renderHandle.syncLayoutFootprint();
        }
        // Shapes paint through an SVG whose viewBox matches the frame — left
        // stale it stretches (image fills visibly distort until pointerup).
        // Re-target the geometry so the live preview matches the final render.
        const info = state.nodeIndex.get(rawNodeId(nodeId));
        if (info && info.node.type === "shape" && root.FMDocRenderer && typeof root.FMDocRenderer.syncShapeSvg === "function") {
          const svg = elNode.querySelector("svg");
          if (svg) {
            try { root.FMDocRenderer.syncShapeSvg(svg, info.node, typeof frame.w === "number" ? frame.w : undefined, typeof frame.h === "number" ? frame.h : undefined); } catch (err) { /* preview only */ }
          }
        }
      }
      const boxEl = state.selBoxes.get(nodeId);
      if (boxEl) {
        // Overlay boxes are page-space: parent-relative frame + parent origin.
        if (!flowChild) {
          boxEl.style.left = (frame.x + org.x) + "pt";
          boxEl.style.top = (frame.y + org.y) + "pt";
          if (typeof frame.w === "number") boxEl.style.width = Math.max(0, frame.w) + "pt";
        }
        if (typeof frame.h === "number") boxEl.style.height = Math.max(0, frame.h) + "pt";
        boxEl.style.transform = frame.rotation ? "rotate(" + frame.rotation + "deg)" : "";
      }
    }

    function trackPointer(startEv, onMove, onUp) {
      const move = function (ev) { onMove(ev); };
      const up = function (ev) {
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        onUp(ev);
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", up, true);
    }

    // ---- pointer gestures ---------------------------------------------------------------------

    function onOverlayPointerDown(entry, ev) {
      if (ev.button !== 0) return;
      if (state.profile === "fill") return;
      if (state.cropSession) {
        // Inside the crop UI its own handlers run; anywhere else applies.
        if (ev.target.closest && ev.target.closest(".fmde-cropui")) return;
        ev.preventDefault();
        commitCropSession();
        return;
      }
      if (state.textEditing) {
        // Clicking outside the text editor commits it.
        if (!state.textEditing.wrap.contains(ev.target)) commitTextEdit();
        else return;
      }
      dom.root.focus({ preventScroll: true });
      ev.preventDefault();
      state.currentPageId = entry.pageId;
      state.selectedPageId = null;
      const pt = pagePoint(entry, ev);

      if (state.pendingInsert) {
        placePendingInsert(entry, pt);
        return;
      }

      const handleDir = ev.target && ev.target.closest ? (function () {
        const h = ev.target.closest("[data-fmde-handle]");
        return h ? h.getAttribute("data-fmde-handle") : null;
      })() : null;

      if (handleDir && state.selection.length) {
        if (handleDir === "rotate") startRotate(entry, ev);
        else startResize(entry, ev, handleDir);
        return;
      }

      // Doc/agent-created pages nest their real elements in page-region
      // frames. Test the rendered node first, then fall back to page maths.
      const hit = isViewDoc() ? hitTestDom(ev) : (hitTestPagedNodeDom(ev, entry.pageId) || hitTest(entry.pageId, pt));
      if (hit) {
        const already = state.selection.indexOf(hit.id) !== -1;
        if (ev.shiftKey) {
          if (already) setSelection(state.selection.filter(function (id) { return id !== hit.id; }));
          else setSelection(state.selection.concat([hit.id]));
          return;
        }
        if (!already) setSelection([hit.id]);
        startMove(entry, ev, pt, hit);
      } else {
        if (!ev.shiftKey) {
          setSelection([]);
          state.enterFrameId = null;
        }
        startMarquee(entry, ev, pt, ev.shiftKey);
      }
    }

    function onOverlayDblClick(entry, ev) {
      if (state.cropSession) { commitCropSession(); return; }
      const view = isViewDoc();
      const pt = pagePoint(entry, ev);
      const hit = view ? hitTestDom(ev) : (hitTestPagedNodeDom(ev, entry.pageId) || hitTest(entry.pageId, pt));
      if (!hit) {
        state.enterFrameId = null;
        const foundPage = !view ? M.findPage(state.doc, entry.pageId) : null;
        if (foundPage && pageCroppable(foundPage.page)) startPageCropSession(entry.pageId, entry.pageEl);
        return;
      }
      if (hit.node.type === "text") {
        startTextEdit(hit.id);
        return;
      }
      if (hit.node.type === "image" && !cropMediaRef(hit.node)) {
        setSelection([hit.id]);
        chooseMediaForImage(hit.id, ev);
        return;
      }
      // Canva-style crop: double-click an image, or a shape/frame whose fill
      // is an image (frames with children keep enter-the-container instead).
      const hasKids = Array.isArray(hit.node.children) && hit.node.children.length;
      if ((hit.node.type === "image" || hit.node.type === "shape" || (hit.node.type === "frame" && !hasKids)) && nodeCroppable(hit.node)) {
        setSelection([hit.id]);
        startCropSession(hit.id);
        return;
      }
      // A plain shape enters text editing. Image-filled shapes are handled by
      // crop mode above so adding editable shape text cannot steal the crop
      // gesture from photos placed inside a shape.
      if (hit.node.type === "shape") {
        setSelection([hit.id]);
        startShapeTextEdit(hit.id);
        return;
      }
      if (isDocumentBodyFrame(hit.node)) {
        setSelection([hit.id]);
        return;
      }
      if (hit.node.type === "frame" && hasKids) {
        state.enterFrameId = hit.id;
        const inner = view ? hitTestDom(ev) : hitTest(entry.pageId, pt);
        if (inner && inner.id !== hit.id) {
          setSelection([inner.id]);
          // Drilled into a container onto a text run — go straight to editing.
          if (inner.node.type === "text") startTextEdit(inner.id);
        }
      }
    }

    function startMove(entry, downEv, startPt, hit) {
      const movers = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (!info || info.pageId !== entry.pageId) continue;
        if (!nodeMovable(info.node)) continue;
        // Sections are stacked by the page's layout — dragging one cannot move
        // it, so don't start a gesture that pretends otherwise.
        // A nested flow child is layout-owned until the user drags it. In
        // Visual, that gesture intentionally turns it into a page-positioned
        // element so Doc/agent-created text can move just like inserted text.
        const floatFlowChildOnMove = !isViewDoc() && isFlowChild(id);
        if (isFlowChild(id) && !floatFlowChildOnMove) continue;
        movers.push({
          id: id,
          node: info.node,
          orig: gestureFrame(info.node),
          origin: gestureOrigin(id),
          floatFlowChildOnMove: floatFlowChildOnMove,
          parentId: info.parentId,
          // Direct children of a page section (view docs) may be dropped into a
          // DIFFERENT section — sections themselves (flow children) never are.
          sectionChild: !!(info.parentId && isFlowChild(info.parentId))
        });
      }
      // While dragging, lift each element above every sibling SECTION: sections
      // keep z:auto, so a positioned child with a huge z-index paints above the
      // backgrounds of later sections instead of vanishing beneath them the
      // moment it crosses a section boundary.
      const lifted = [];
      const liftMovers = function () {
        if (lifted.length || !state.renderHandle || typeof state.renderHandle.nodeElement !== "function") return;
        for (const m of movers) {
          let elNode = null;
          try { elNode = state.renderHandle.nodeElement(m.id); } catch (err) { elNode = null; }
          if (!elNode) continue;
          lifted.push({ el: elNode, prev: elNode.style.zIndex });
          elNode.style.zIndex = "9999";
        }
      };
      const unliftMovers = function () {
        for (const entryLift of lifted) entryLift.el.style.zIndex = entryLift.prev;
        lifted.length = 0;
      };
      const tolerance = SNAP_TOLERANCE_PX * (entry.ptPerPx || 1);
      const lines = collectSnapLines(entry.pageId, state.selection);
      // A multi-selection snaps as one object using its rendered bounding box.
      const moverPageBounds = function (mover) {
        const origin = mover.origin || { x: 0, y: 0 };
        return M.frameBounds({
          x: mover.orig.x + origin.x,
          y: mover.orig.y + origin.y,
          w: mover.orig.w,
          h: mover.orig.h,
          rotation: mover.orig.rotation
        });
      };
      const snapBaseBounds = movers.reduce(function (combined, mover) {
        const bounds = moverPageBounds(mover);
        if (!combined) return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
        const right = Math.max(combined.x + combined.w, bounds.x + bounds.w);
        const bottom = Math.max(combined.y + combined.h, bounds.y + bounds.h);
        combined.x = Math.min(combined.x, bounds.x);
        combined.y = Math.min(combined.y, bounds.y);
        combined.w = right - combined.x;
        combined.h = bottom - combined.y;
        return combined;
      }, null);
      let moved = false;
      trackPointer(downEv, function (ev) {
        if (!movers.length) return;
        const pt = pagePoint(entry, ev);
        let dx = pt.x - startPt.x;
        let dy = pt.y - startPt.y;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX * (entry.ptPerPx || 1) && Math.abs(dy) < DRAG_THRESHOLD_PX * (entry.ptPerPx || 1)) return;
        moved = true;
        liftMovers();
        let snap = { vLine: null, hLine: null, dx: 0, dy: 0 };
        if (snapBaseBounds && !ev.altKey) {
          // Snap in PAGE space: guides are page-space, frames are parent-space.
          const b = { x: snapBaseBounds.x + dx, y: snapBaseBounds.y + dy, w: snapBaseBounds.w, h: snapBaseBounds.h };
          snap = applyEqualSpacingSnap(snapAdjust(b, lines, tolerance), b, lines.boxes, tolerance);
          dx += snap.dx;
          dy += snap.dy;
        }
        showGuides(entry, snap);
        for (const m of movers) {
          liveSetFrame(m.id, Object.assign({}, m.orig, { x: roundPt(m.orig.x + dx), y: roundPt(m.orig.y + dy) }), m.origin, m.floatFlowChildOnMove);
        }
        movers._dx = dx;
        movers._dy = dy;
      }, function (upEvent) {
        clearGuides();
        unliftMovers();
        if (!moved || !movers.length) {
          // Plain click on an already-selected node collapses multi-selection.
          if (!moved && state.selection.length > 1 && !downEv.shiftKey) setSelection([hit.id]);
          return;
        }
        const dx = movers._dx || 0;
        const dy = movers._dy || 0;
        const commands = [];
        let destination = null;
        if (!isViewDoc() && upEvent) {
          for (const pageEl of pageElements()) {
            const rect = pageEl.getBoundingClientRect();
            if (upEvent.clientX < rect.left || upEvent.clientX > rect.right || upEvent.clientY < rect.top || upEvent.clientY > rect.bottom) continue;
            const pageId = rawNodeId(pageEl.getAttribute("data-page-id") || "");
            if (pageId !== entry.pageId && M.findPage(state.doc, pageId)) destination = { id: pageId, el: pageEl, rect: rect };
          }
        }
        for (const m of movers) {
          const frame = Object.assign({}, m.orig, { x: roundPt(m.orig.x + dx), y: roundPt(m.orig.y + dy) });
          if (destination) {
            const sourceRect = entry.pageEl.getBoundingClientRect();
            const origin = m.origin || { x: 0, y: 0 };
            const pageX = frame.x + num(origin.x, 0);
            const pageY = frame.y + num(origin.y, 0);
            const screenX = sourceRect.left + pageX * sourceRect.width / entry.w_pt;
            const screenY = sourceRect.top + pageY * sourceRect.height / entry.h_pt;
            const targetFrame = Object.assign({}, frame, {
              x: roundPt((screenX - destination.rect.left) * entry.w_pt / destination.rect.width),
              y: roundPt((screenY - destination.rect.top) * entry.h_pt / destination.rect.height),
              z: Math.max(1, nextZ(destination.id)),
              layout: "absolute"
            });
            if (m.node.type === "widget" || m.node.type === "table") commands.push({ type: "node.set", node_id: m.id, prop: "props.object_layout", value: "front" });
            commands.push({ type: "node.set_anchor", node_id: m.id, anchor: "page" });
            commands.push({ type: "node.move", node_id: m.id, parent_id: null, page_id: destination.id, frame: targetFrame });
            continue;
          }
          const target = m.sectionChild ? reparentTargetSection(m, frame) : null;
          if (target) {
            // ONE undoable batch: node.move retargets the parent and merges the
            // new x/y (its inverse restores the original parent, index AND
            // frame); frame.z lands via node.set so undo can null it back out.
            const targetFrame = responsiveFramePosition(m.id, Object.assign({}, frame, { x: target.x, y: target.y }), target.parentId);
            commands.push({ type: "node.move", node_id: m.id, parent_id: target.parentId, frame: targetFrame });
            commands.push({ type: "node.set", node_id: m.id, prop: "frame.z", value: target.z });
          } else if (m.floatFlowChildOnMove) {
            if (m.node.type === "widget" || m.node.type === "table") commands.push({ type: "node.set", node_id: m.id, prop: "props.object_layout", value: "front" });
            commands.push({ type: "node.set_anchor", node_id: m.id, anchor: "page" });
            commands.push({ type: "node.set", node_id: m.id, prop: "frame", value: Object.assign({}, frame, { z: Math.max(1, num(frame.z, 0)), layout: "absolute" }) });
          } else {
            commands.push({ type: "node.set", node_id: m.id, prop: "frame", value: responsiveFramePosition(m.id, frame) });
          }
        }
        runCommands(commands, "move");
      });
    }

    /** Cross-section drop (view docs): when a section child's final PAGE-space
     *  center lands inside a DIFFERENT section's box, return the reparent
     *  target — the new section id plus the frame x/y that keep the node at
     *  its committed page position, and a z above everything already there.
     *  Returns null (keep the old parent) for drops on no section, the same
     *  section, or any non-finite geometry. */
    function reparentTargetSection(mover, frame) {
      if (!isViewDoc() || !state.doc || !state.doc.root) return null;
      const w = num(frame.w, NaN);
      const h = num(frame.h, NaN);
      const origin = mover.origin || { x: 0, y: 0 };
      const pageX = num(frame.x, NaN) + num(origin.x, 0);
      const pageY = num(frame.y, NaN) + num(origin.y, 0);
      if (!Number.isFinite(pageX) || !Number.isFinite(pageY) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
      const cx = pageX + w / 2;
      const cy = pageY + h / 2;
      for (const section of state.doc.root.children || []) {
        if (!section || section.id === mover.parentId) continue;
        // Only page sections (flow children of the view root) are drop targets.
        if (!isFlowChild(section.id)) continue;
        const box = overlayBox(section.id);
        if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.w) || !Number.isFinite(box.h)) continue;
        if (cx < box.x || cx > box.x + box.w || cy < box.y || cy > box.y + box.h) continue;
        let x = roundPt(pageX - box.x);
        // Clamp into the target section so the node cannot commit off-section.
        let y = roundPt(clamp(pageY - box.y, 0, Math.max(0, box.h - h)));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        let z = 0;
        for (const sibling of section.children || []) {
          z = Math.max(z, (num(sibling.frame && sibling.frame.z, 0) || 0) + 1);
        }
        return { parentId: section.id, x: x, y: y, z: z };
      }
      return null;
    }

    function startResize(entry, downEv, dir) {
      const vec = HANDLE_VECTORS[dir];
      if (!vec) return;
      // Website section width is responsive rather than a fixed frame value.
      // Horizontal handles are the direct-manipulation control for the fixed
      // maximum only. Target percentage belongs exclusively to its slider;
      // dragging a handle must never silently rewrite that responsive target.
      if (state.selection.length === 1 && isStructuralSection(state.selection[0]) && vec.x) {
        startStructuralSectionWidthResize(entry, downEv, dir, state.selection[0]);
        return;
      }
      const targets = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (!info || info.pageId !== entry.pageId) continue;
        if (!nodeResizable(info.node)) continue;
        targets.push({
          id: id,
          node: info.node,
          orig: gestureFrame(info.node),
          origin: gestureOrigin(id),
          floatFlowChildOnResize: !isViewDoc() && isFlowChild(id)
        });
      }
      if (!targets.length) return;

      if (targets.length === 1) {
        resizeSingle(entry, downEv, dir, targets[0]);
      } else {
        resizeMulti(entry, downEv, dir, targets);
      }
    }

    /** Keep the cross-axis size of a flow stack linked. This is especially
     * important for pricing stacks, where the repeater, li_header and
     * li_totals are separate siblings but form one visual table. */
    function flowCrossAxisResizeCommands(target, next, vec) {
      const info = state.nodeIndex.get(target.id);
      const parentInfo = info && info.parentId ? state.nodeIndex.get(info.parentId) : null;
      const parent = parentInfo && parentInfo.node;
      if (!parent || !parent.frame || parent.frame.layout !== "flow") return null;
      const flow = parent.props && parent.props.flow || {};
      const direction = flow.direction === "row" ? "row" : "column";
      const padding = Array.isArray(flow.padding) ? flow.padding : [0, 0, 0, 0];
      const commands = [];
      if (direction === "column" && vec.x !== 0 && Number.isFinite(next.w)) {
        const contentW = Math.max(MIN_NODE_SIZE_PT, next.w);
        commands.push({
          type: "node.set", node_id: parent.id, prop: "frame", value: Object.assign({}, parent.frame, {
            x: roundPt(num(parent.frame.x, 0) + (vec.x < 0 ? num(next.x, 0) : 0)),
            w: roundPt(contentW + num(padding[1], 0) + num(padding[3], 0))
          })
        });
        for (const sibling of parent.children || []) {
          if (!sibling || sibling.anchor === "page") continue;
          commands.push({ type: "node.set", node_id: sibling.id, prop: "frame.w", value: roundPt(contentW) });
        }
        if (vec.y !== 0 && Number.isFinite(next.h)) {
          commands.push({ type: "node.set", node_id: target.id, prop: "frame.h", value: roundPt(next.h) });
        }
        return commands;
      }
      if (direction === "row" && vec.y !== 0 && Number.isFinite(next.h)) {
        const contentH = Math.max(MIN_NODE_SIZE_PT, next.h);
        commands.push({
          type: "node.set", node_id: parent.id, prop: "frame", value: Object.assign({}, parent.frame, {
            y: roundPt(num(parent.frame.y, 0) + (vec.y < 0 ? num(next.y, 0) : 0)),
            h: roundPt(contentH + num(padding[0], 0) + num(padding[2], 0))
          })
        });
        for (const sibling of parent.children || []) {
          if (!sibling || sibling.anchor === "page") continue;
          commands.push({ type: "node.set", node_id: sibling.id, prop: "frame.h", value: roundPt(contentH) });
        }
        if (vec.x !== 0 && Number.isFinite(next.w)) {
          commands.push({ type: "node.set", node_id: target.id, prop: "frame.w", value: roundPt(next.w) });
        }
        return commands;
      }
      return null;
    }

    function onOverlayContextMenu(entry, ev) {
      if (state.profile === "fill" || state.cropSession) return;
      const tableCell = document.elementsFromPoint ? document.elementsFromPoint(ev.clientX, ev.clientY).find(function (candidate) {
        return candidate && candidate.matches && candidate.matches("td[data-cell], th[data-cell]");
      }) : null;
      const tableHit = tableCell && docProjection.tableCellFrom(tableCell);
      if (tableHit && tableHit.nodeId) {
        ev.preventDefault();
        ev.stopPropagation();
        setSelection([tableHit.nodeId], { keepInspector: true });
        showTableCellContextMenu(tableHit, ev.clientX, ev.clientY);
        return;
      }
      const pt = pagePoint(entry, ev);
      const hit = isViewDoc() ? hitTestDom(ev) : (hitTestPagedNodeDom(ev, entry.pageId) || hitTest(entry.pageId, pt));
      if (!hit) {
        if (!isViewDoc() && M.findPage(state.doc, entry.pageId)) {
          ev.preventDefault();
          ev.stopPropagation();
          showPageContextMenu(entry.pageId, ev.clientX, ev.clientY, entry.pageEl);
        }
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      state.currentPageId = entry.pageId;
      state.selectedPageId = null;
      if (state.selection.indexOf(hit.id) === -1) setSelection([hit.id]);
      showElementContextMenu(hit.id, ev.clientX, ev.clientY, renderedNodeElement(hit.id), hit.sourceId || hit.id);
    }

    /** Resize one node — correct for rotated frames: pointer deltas are taken
     * in the node's local space and the fixed anchor (opposite handle) stays
     * pinned in page space. */
    function resizeSingle(entry, downEv, dir, target) {
      let vec = HANDLE_VECTORS[dir];
      if (target.node.type === "widget") {
        const axes = widgetResizeAxes(target.node);
        vec = { x: axes.x ? vec.x : 0, y: axes.y ? vec.y : 0 };
        if (!vec.x && !vec.y) return;
      }
      const orig = target.orig;
      const rot = orig.rotation || 0;
      const cx = orig.x + orig.w / 2;
      const cy = orig.y + orig.h / 2;
      const anchorLocal = { x: cx - vec.x * orig.w / 2, y: cy - vec.y * orig.h / 2 };
      const anchor = rot ? M.rotatePoint(anchorLocal.x, anchorLocal.y, cx, cy, rot) : anchorLocal;
      // Frames are parent-relative; the pointer is page-space. Convert once so
      // every gesture below stays in the node's own coordinate space.
      const origin = gestureOrigin(target.id);
      const tolerance = SNAP_TOLERANCE_PX * (entry.ptPerPx || 1);
      const lines = collectSnapLines(entry.pageId, state.selection);
      const groupFrames = {};
      if (isGroupNode(target.node)) {
        (function capture(node) {
          for (const child of node.children || []) {
            groupFrames[child.id] = gestureFrame(child);
            capture(child);
          }
        })(target.node);
      }
      const resizingGroup = Object.keys(groupFrames).length > 0;
      let last = null;
      let lastGroupFrames = null;
      trackPointer(downEv, function (ev) {
        const pagePt = pagePoint(entry, ev);
        const pt = { x: pagePt.x - origin.x, y: pagePt.y - origin.y };
        let vx = pt.x - anchor.x;
        let vy = pt.y - anchor.y;
        if (rot) {
          const rad = -rot * Math.PI / 180;
          const rx = vx * Math.cos(rad) - vy * Math.sin(rad);
          const ry = vx * Math.sin(rad) + vy * Math.cos(rad);
          vx = rx; vy = ry;
        }
        let w = vec.x !== 0 ? Math.max(MIN_NODE_SIZE_PT, vx * vec.x) : orig.w;
        let h = vec.y !== 0 ? Math.max(MIN_NODE_SIZE_PT, vy * vec.y) : orig.h;
        if (ev.shiftKey && vec.x !== 0 && vec.y !== 0 && orig.w > 0 && orig.h > 0) {
          const scale = Math.max(w / orig.w, h / orig.h);
          w = Math.max(MIN_NODE_SIZE_PT, orig.w * scale);
          h = Math.max(MIN_NODE_SIZE_PT, orig.h * scale);
        }
        const centerLocal = { x: vec.x !== 0 ? vec.x * w / 2 : 0, y: vec.y !== 0 ? vec.y * h / 2 : 0 };
        // When an axis is not being resized the center keeps its original
        // offset from the anchor along that axis.
        if (vec.x === 0) centerLocal.x = cx - anchorLocal.x;
        if (vec.y === 0) centerLocal.y = cy - anchorLocal.y;
        let ncx = anchor.x + centerLocal.x;
        let ncy = anchor.y + centerLocal.y;
        if (rot) {
          const rad = rot * Math.PI / 180;
          ncx = anchor.x + centerLocal.x * Math.cos(rad) - centerLocal.y * Math.sin(rad);
          ncy = anchor.y + centerLocal.x * Math.sin(rad) + centerLocal.y * Math.cos(rad);
        }
        last = Object.assign({}, orig, {
          x: roundPt(ncx - w / 2),
          y: roundPt(ncy - h / 2),
          w: roundPt(w),
          h: roundPt(h)
        });
        // Snap the edges being dragged to the alignment guides (axis-aligned
        // frames only — a rotated box has no axis-aligned edge to align).
        let guide = { vLine: null, hLine: null };
        if (!rot && !ev.altKey) {
          const pageX = last.x + origin.x;
          const pageY = last.y + origin.y;
          if (vec.x > 0) {
            const line = nearestLine(lines.v, pageX + last.w, tolerance);
            if (line !== null) { last.w = roundPt(Math.max(MIN_NODE_SIZE_PT, line - pageX)); guide.vLine = line; }
          } else if (vec.x < 0) {
            const line = nearestLine(lines.v, pageX, tolerance);
            if (line !== null) {
              const right = pageX + last.w;
              const nx = Math.min(line, right - MIN_NODE_SIZE_PT);
              last.x = roundPt(nx - origin.x);
              last.w = roundPt(right - nx);
              guide.vLine = line;
            }
          }
          if (vec.y > 0) {
            const line = nearestLine(lines.h, pageY + last.h, tolerance);
            if (line !== null) { last.h = roundPt(Math.max(MIN_NODE_SIZE_PT, line - pageY)); guide.hLine = line; }
          } else if (vec.y < 0) {
            const line = nearestLine(lines.h, pageY, tolerance);
            if (line !== null) {
              const bottom = pageY + last.h;
              const ny = Math.min(line, bottom - MIN_NODE_SIZE_PT);
              last.y = roundPt(ny - origin.y);
              last.h = roundPt(bottom - ny);
              guide.hLine = line;
            }
          }
        }
        showGuides(entry, guide);
        liveSetFrame(target.id, last, origin, target.floatFlowChildOnResize);
        if (resizingGroup) {
          const scaleX = orig.w > 0 ? last.w / orig.w : 1;
          const scaleY = orig.h > 0 ? last.h / orig.h : 1;
          lastGroupFrames = scaleGroupedFrameTree(M, target.node, last, scaleX, scaleY, groupFrames, isViewDoc());
          const pageOrigins = new Map([[target.id, { x: origin.x + last.x, y: origin.y + last.y }]]);
          for (const member of lastGroupFrames) {
            const parentOrigin = pageOrigins.get(member.parent_id) || { x: origin.x + last.x, y: origin.y + last.y };
            liveSetFrame(member.id, member.frame, parentOrigin);
            pageOrigins.set(member.id, { x: parentOrigin.x + member.frame.x, y: parentOrigin.y + member.frame.y });
          }
        }
      }, function () {
        clearGuides();
        if (!last) return;
        if (resizingGroup) {
          const committedGroupFrame = responsiveFramePosition(target.id, last);
          const authoredParentWidths = new Map([[target.id, num(committedGroupFrame.w, 0)]]);
          const commands = [{ type: "node.set", node_id: target.id, prop: "frame", value: committedGroupFrame }];
          for (const member of lastGroupFrames || []) {
            const committedMemberFrame = responsiveFramePosition(
              member.id,
              member.frame,
              member.parent_id,
              authoredParentWidths.get(member.parent_id)
            );
            commands.push({ type: "node.set", node_id: member.id, prop: "frame", value: committedMemberFrame });
            authoredParentWidths.set(member.id, num(committedMemberFrame.w, 0));
          }
          runCommands(commands, "resize group");
          return;
        }
        if (target.floatFlowChildOnResize) {
          const commands = [];
          if (target.node.type === "widget") commands.push({ type: "node.set", node_id: target.id, prop: "props.object_layout", value: "front" });
          commands.push({ type: "node.set_anchor", node_id: target.id, anchor: "page" });
          commands.push({ type: "node.set", node_id: target.id, prop: "frame", value: responsiveFramePosition(target.id, last) });
          runCommands(commands, "resize");
          return;
        }
        const linkedFlowCommands = flowCrossAxisResizeCommands(target, last, vec);
        if (linkedFlowCommands && linkedFlowCommands.length) {
          runCommands(linkedFlowCommands, "resize");
          return;
        }
        // A section's x/y/w are owned by the page layout — only its height is
        // authored, so don't bake measured values back into the model.
        const value = isFlowChild(target.id)
          ? Object.assign({}, target.orig, { x: (target.node.frame || {}).x, y: (target.node.frame || {}).y, w: (target.node.frame || {}).w, h: last.h })
          : responsiveFramePosition(target.id, last);
        runCommands([{ type: "node.set", node_id: target.id, prop: "frame", value: value }], "resize");
      });
    }

    /** Multi-selection resize: the shared bounding box is scaled and the scale
     *  is applied to each node's frame independently (v1 simplification). */
    function resizeMulti(entry, downEv, dir, targets) {
      const vec = HANDLE_VECTORS[dir];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const t of targets) {
        // Use the exact PAGE-space geometry that draws the visible multi
        // selection box. Member frames may be relative to different section
        // parents, so scaling their raw frame.x/y cannot represent the group.
        const measured = overlayBox(t.id);
        const origin = t.origin || { x: 0, y: 0 };
        const source = measured && Number.isFinite(measured.x)
          ? measured
          : { x: t.orig.x + origin.x, y: t.orig.y + origin.y, w: t.orig.w, h: t.orig.h, rotation: t.orig.rotation };
        const b = M.frameBounds(source);
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
      }
      const bb = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
      const anchor = { x: bb.x + (vec.x === -1 ? bb.w : 0), y: bb.y + (vec.y === -1 ? bb.h : 0) };
      if (vec.x === 0) anchor.x = bb.x;
      if (vec.y === 0) anchor.y = bb.y;
      const tolerance = SNAP_TOLERANCE_PX * (entry.ptPerPx || 1);
      const lines = collectSnapLines(entry.pageId, state.selection);
      let lastFrames = null;
      trackPointer(downEv, function (ev) {
        const pt = pagePoint(entry, ev);
        let fw = vec.x !== 0 ? Math.max(0.05, (pt.x - anchor.x) * vec.x / bb.w) : 1;
        let fh = vec.y !== 0 ? Math.max(0.05, (pt.y - anchor.y) * vec.y / bb.h) : 1;
        if (ev.shiftKey && vec.x !== 0 && vec.y !== 0) { const f = Math.max(fw, fh); fw = f; fh = f; }
        const originX = vec.x === -1 ? bb.x + bb.w : bb.x;
        const originY = vec.y === -1 ? bb.y + bb.h : bb.y;
        let guide = { vLine: null, hLine: null };
        if (!ev.altKey) {
          const candidates = [];
          if (vec.x !== 0) {
            const edge = anchor.x + vec.x * bb.w * fw;
            const line = nearestLine(lines.v, edge, tolerance);
            if (line !== null) candidates.push({ axis: "x", line: line, delta: Math.abs(line - edge), factor: Math.max(0.05, (line - anchor.x) * vec.x / bb.w) });
          }
          if (vec.y !== 0) {
            const edge = anchor.y + vec.y * bb.h * fh;
            const line = nearestLine(lines.h, edge, tolerance);
            if (line !== null) candidates.push({ axis: "y", line: line, delta: Math.abs(line - edge), factor: Math.max(0.05, (line - anchor.y) * vec.y / bb.h) });
          }
          if (ev.shiftKey && vec.x !== 0 && vec.y !== 0 && candidates.length) {
            // Aspect-locked resize can only accept one scale. Prefer the guide
            // closest to the dragged corner, then report any second guide the
            // resulting shared factor also lands on.
            candidates.sort(function (a, b) { return a.delta - b.delta; });
            fw = candidates[0].factor;
            fh = candidates[0].factor;
            const xEdge = anchor.x + vec.x * bb.w * fw;
            const yEdge = anchor.y + vec.y * bb.h * fh;
            guide.vLine = nearestLine(lines.v, xEdge, tolerance);
            guide.hLine = nearestLine(lines.h, yEdge, tolerance);
          } else {
            for (const candidate of candidates) {
              if (candidate.axis === "x") { fw = candidate.factor; guide.vLine = candidate.line; }
              else { fh = candidate.factor; guide.hLine = candidate.line; }
            }
          }
        }
        lastFrames = targets.map(function (t) {
          const o = t.orig;
          const parentOrigin = t.origin || { x: 0, y: 0 };
          const pageX = o.x + parentOrigin.x;
          const pageY = o.y + parentOrigin.y;
          return {
            id: t.id,
            frame: Object.assign({}, o, {
              x: roundPt(originX + (pageX - originX) * fw - parentOrigin.x),
              y: roundPt(originY + (pageY - originY) * fh - parentOrigin.y),
              w: roundPt(Math.max(MIN_NODE_SIZE_PT, o.w * fw)),
              h: roundPt(Math.max(MIN_NODE_SIZE_PT, o.h * fh))
            })
          };
        });
        showGuides(entry, guide);
        for (const f of lastFrames) {
          const target = targets.find(function (item) { return item.id === f.id; });
          liveSetFrame(f.id, f.frame, target && target.origin);
        }
      }, function () {
        clearGuides();
        if (!lastFrames) return;
        runCommands(lastFrames.map(function (f) {
          return { type: "node.set", node_id: f.id, prop: "frame", value: responsiveFramePosition(f.id, f.frame) };
        }), "resize");
      });
    }

    function startRotate(entry, downEv) {
      const id = state.selection[0];
      const info = state.nodeIndex.get(id);
      if (!info || !nodeRotatable(info.node)) return;
      const orig = gestureFrame(info.node);
      const origin = gestureOrigin(id);
      const box = overlayBox(id);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const startPt = pagePoint(entry, downEv);
      const startAngle = Math.atan2(startPt.y - cy, startPt.x - cx) * 180 / Math.PI;
      let last = null;
      trackPointer(downEv, function (ev) {
        const pt = pagePoint(entry, ev);
        const angle = Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI;
        let rotation = (orig.rotation || 0) + (angle - startAngle);
        if (ev.shiftKey) rotation = Math.round(rotation / 15) * 15;
        else {
          const snap45 = Math.round(rotation / 45) * 45;
          if (Math.abs(rotation - snap45) <= ROTATE_SNAP_TOLERANCE_DEG) rotation = snap45;
        }
        rotation = Math.round(rotation * 10) / 10;
        // Normalize to (-180, 180]
        rotation = ((rotation + 180) % 360 + 360) % 360 - 180;
        last = Object.assign({}, orig, { rotation: rotation });
        liveSetFrame(id, last, origin);
      }, function () {
        if (!last) return;
        runCommands([{ type: "node.set", node_id: id, prop: "frame", value: responsiveFramePosition(id, last) }], "rotate");
      });
    }

    function startMarquee(entry, downEv, startPt, additive) {
      const marquee = el("div", { class: "fmde-marquee" });
      entry.overlay.appendChild(marquee);
      const baseSelection = additive ? state.selection.slice() : [];
      let rect = null;
      trackPointer(downEv, function (ev) {
        const pt = pagePoint(entry, ev);
        rect = {
          x: Math.min(startPt.x, pt.x),
          y: Math.min(startPt.y, pt.y),
          w: Math.abs(pt.x - startPt.x),
          h: Math.abs(pt.y - startPt.y)
        };
        marquee.style.left = rect.x + "pt";
        marquee.style.top = rect.y + "pt";
        marquee.style.width = rect.w + "pt";
        marquee.style.height = rect.h + "pt";
        marquee.classList.add("show");
      }, function () {
        marquee.remove();
        if (!rect || (rect.w < 2 && rect.h < 2)) return;
        const page = M.findPage(state.doc, entry.pageId);
        if (!page) return;
        const ids = baseSelection.slice();
        for (const node of page.page.children || []) {
          if (node.visible === false) continue;
          const b = M.frameBounds(node.frame || {});
          if (M.rectsIntersect(rect, b) && ids.indexOf(node.id) === -1) ids.push(node.id);
        }
        setSelection(ids);
      });
    }

    // ---- crop mode (Canva-style) ---------------------------------------------------------------
    // Double-clicking an image node — or a shape/frame with an image FILL —
    // enters crop mode: the full image shows translucent around the node's
    // frame (the fixed viewport), with its own bordered resize/move box.
    // Inside the viewport the image is solid. Dragging pans, corner handles
    // zoom (aspect-locked, anchored at the opposite corner), and the image
    // is clamped so the viewport always stays covered. Commit writes a
    // normalized crop rect ({x,y,w,h} as fractions of the frame):
    //   image node  -> props.crop
    //   image fill  -> style.fill.crop

    function cropMediaRef(node) {
      if (!node) return null;
      if (node.type === "image") return (node.props && node.props.media) || null;
      const fill = node.style && node.style.fill;
      if ((node.type === "shape" || node.type === "frame") && fill && fill.type === "image") return fill.media || null;
      return null;
    }

    function cropMediaUrl(node) {
      const ref = cropMediaRef(node);
      if (!ref) return "";
      if (typeof ref === "string") return ref;
      if (ref.url) return ref.url;
      if (opts.media && typeof opts.media.url === "function") {
        try { return opts.media.url(ref, ref.variant) || ""; } catch (err) { return ""; }
      }
      return "";
    }

    function currentCrop(node) {
      const crop = node.type === "image"
        ? (node.props && node.props.crop)
        : (node.style && node.style.fill && node.style.fill.crop);
      if (!crop) return null;
      const c = { x: num(crop.x, 0), y: num(crop.y, 0), w: num(crop.w, 0), h: num(crop.h, 0) };
      return c.w > 0 && c.h > 0 ? c : null;
    }

    function cropPreviewRadius(node) {
      if (!node) return 0;
      if (node.type === "shape") {
        if (node.props && node.props.shape === "ellipse") return "50%";
        return Math.max(0, num(node.props && node.props.corner_radius, 0)) + "pt";
      }
      const radius = node.style && node.style.radius;
      return Math.max(0, num(Array.isArray(radius) ? radius[0] : radius, 0)) + "pt";
    }

    function buildCropObjectPreview(node, sourceEl) {
      const preview = el("div", { class: "fmde-crop-object-preview" });
      const radius = cropPreviewRadius(node);
      preview.style.borderRadius = radius;
      const stroke = strokeState(node);
      if (stroke.width > 0) preview.style.boxShadow = "inset 0 0 0 " + stroke.width + "pt " + stroke.color;
      if (node && node.type === "shape" && node.props && node.props.text !== undefined && node.props.text !== null && String(node.props.text) !== "") {
        const textStyle = node.props.text_style || {};
        const label = el("div", { class: "fmde-crop-object-text", text: String(node.props.text) });
        label.style.fontFamily = textStyle.family || "Arial";
        label.style.fontSize = num(textStyle.size_pt, 12) + "pt";
        label.style.fontWeight = String(textStyle.weight || 400);
        label.style.fontStyle = textStyle.italic ? "italic" : "normal";
        label.style.textDecoration = textStyle.underline ? "underline" : "none";
        label.style.color = textStyle.color || defaultShapeTextColor(node);
        const align = node.props.text_align || "center";
        label.style.textAlign = align;
        label.style.justifyContent = align === "left" ? "flex-start" : (align === "right" ? "flex-end" : "center");
        const valign = node.props.text_valign || "middle";
        label.style.alignItems = valign === "top" ? "flex-start" : (valign === "bottom" ? "flex-end" : "center");
        // The renderer may resolve catalog font names, inherited defaults and
        // browser-normalized decoration values. Copy the displayed label's
        // computed typography so crop mode is visually identical rather than
        // approximating it from only the serialized fields.
        const renderedLabel = sourceEl && sourceEl.querySelector ? sourceEl.querySelector(".fmdoc-shape-label") : null;
        if (renderedLabel && root.getComputedStyle) {
          const computed = root.getComputedStyle(renderedLabel);
          ["fontFamily", "fontSize", "fontWeight", "fontStyle", "textDecoration", "color", "letterSpacing", "lineHeight", "textTransform", "textAlign", "justifyContent", "alignItems", "padding"].forEach(function (property) {
            label.style[property] = computed[property];
          });
        }
        preview.appendChild(label);
      }
      return preview;
    }

    function nodeCroppable(node) {
      if (!node || !can("images")) return false;
      if (node.frame && num(node.frame.rotation, 0)) return false; // v1: axis-aligned only
      if (lockBlocked(node, "resize")) return false;
      return !!cropMediaUrl(node);
    }

    function chooseMediaForImage(nodeId, event) {
      const found = M.findNode(state.doc, rawNodeId(nodeId));
      if (!found || !found.node || found.node.type !== "image") return false;
      if (!(opts.media && typeof opts.media.pick === "function")) {
        showStatus("No media picker is configured", true);
        return false;
      }
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      Promise.resolve(opts.media.pick({ accept: "image/*", mediaKind: "media" })).then(function (ref) {
        if (!ref || !M.findNode(state.doc, nodeId)) return;
        const commands = [{ type: "node.set", node_id: nodeId, prop: "props.media", value: ref }];
        if (found.node.props && found.node.props.crop) commands.push({ type: "node.set", node_id: nodeId, prop: "props.crop", value: null });
        runCommands(commands, "image:replace");
        setSelection([nodeId]);
      }).catch(function () { /* picker cancelled */ });
      return true;
    }

    function pageCropNode(page) {
      return page ? { id: "__page__" + page.id, type: "frame", style: page.style || {}, frame: {} } : null;
    }

    function pageCroppable(page) {
      return nodeCroppable(pageCropNode(page));
    }

    function startPageCropSession(pageId, pageEl) {
      const found = M.findPage(state.doc, pageId);
      if (!found || !pageCroppable(found.page)) return false;
      startCropSession("__page__" + pageId, pageEl, { pageId: pageId, page: found.page, node: pageCropNode(found.page) });
      return true;
    }

    function startDocCropFromElement(nodeEl, event) {
      if (state.mode !== "doc" || state.cropSession || !nodeEl) return false;
      const nodeId = rawNodeId(nodeEl.getAttribute("data-node-id") || "");
      const info = nodeId && state.nodeIndex.get(nodeId);
      if (!info || !nodeCroppable(info.node)) return false;
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      clearDocImageSelection();
      setSelection([nodeId]);
      startCropSession(nodeId, nodeEl);
      return true;
    }

    function cancelCropSession() {
      const session = state.cropSession;
      if (!session) return;
      state.cropSession = null;
      if (session.entry && session.entry.pageEl) session.entry.pageEl.classList.remove("fmde-crop-active");
      try { session.ui.remove(); } catch (err) { /* overlay already rebuilt */ }
      if (session.entry && session.entry.ownsOverlay) {
        try { session.entry.overlay.remove(); } catch (err) { /* page already rebuilt */ }
      }
      dom.hint.classList.remove("show");
    }

    function commitCropSession() {
      const session = state.cropSession;
      if (!session) return;
      const { V, I, nodeId, node } = session;
      cancelCropSession();
      const crop = {
        x: Math.round(((I.x - V.x) / V.w) * 10000) / 10000,
        y: Math.round(((I.y - V.y) / V.h) * 10000) / 10000,
        w: Math.round((I.w / V.w) * 10000) / 10000,
        h: Math.round((I.h / V.h) * 10000) / 10000
      };
      const prop = node.type === "image" ? "props.crop" : "style.fill.crop";
      const command = session.pageId
        ? { type: "page.set", page_id: session.pageId, prop: prop, value: crop }
        : { type: "node.set", node_id: nodeId, prop: prop, value: crop };
      runCommands([command], "crop");
    }

    function startCropSession(nodeId, sourceEl, pageTarget) {
      cancelCropSession();
      const info = pageTarget ? { node: pageTarget.node, pageId: pageTarget.pageId } : state.nodeIndex.get(rawNodeId(nodeId));
      if (!info || !nodeCroppable(info.node)) return;
      let renderedSource = sourceEl || null;
      if (!renderedSource && state.renderHandle && typeof state.renderHandle.nodeElement === "function") {
        try { renderedSource = state.renderHandle.nodeElement(nodeId); } catch (err) { renderedSource = null; }
      }
      let entry = pageTarget ? entryForPage(pageTarget.pageId) : null;
      let box = pageTarget && entry ? { x: 0, y: 0, w: entry.w_pt, h: entry.h_pt, rotation: 0, pageId: pageTarget.pageId } : overlayBox(nodeId);
      if (!entry) entry = box && box.pageId ? entryForPage(box.pageId) : null;
      if (state.mode === "doc") {
        const rendered = renderedSource || dom.stage.querySelector('[data-node-id="' + String(nodeId).replace(/"/g, '\\"') + '"], [data-node-id="' + String(nodeId).replace(/"/g, '\\"') + '::part0"]');
        const pageEl = rendered && rendered.matches && rendered.matches(".fmdoc-page") ? rendered : (rendered && rendered.closest ? rendered.closest(".fmdoc-page") : null);
        if (!rendered || !pageEl) return;
        const pageRect = pageEl.getBoundingClientRect();
        const nodeRect = pageTarget ? pageRect : rendered.getBoundingClientRect();
        const paper = dims();
        const pageWpt = isViewDoc() && pageEl.offsetWidth ? pageEl.offsetWidth / PX_PER_PT : paper.w_pt;
        const pageHpt = isViewDoc() && pageEl.offsetHeight ? pageEl.offsetHeight / PX_PER_PT : paper.h_pt;
        const kx = pageRect.width ? pageWpt / pageRect.width : 1;
        const ky = isViewDoc() ? kx : (pageRect.height ? pageHpt / pageRect.height : kx);
        const overlay = el("div", { class: "fmde-overlay fmde-doc-crop-overlay", "data-fmde-page": pageEl.getAttribute("data-page-id") || "" });
        pageEl.appendChild(overlay);
        entry = { pageId: rawNodeId(pageEl.getAttribute("data-page-id") || info.pageId || ""), pageEl: pageEl, overlay: overlay, w_pt: pageWpt, h_pt: pageHpt, ownsOverlay: true };
        updateOverlayMetrics(entry);
        box = {
          x: (nodeRect.left - pageRect.left) * kx,
          y: (nodeRect.top - pageRect.top) * ky,
          w: nodeRect.width * kx,
          h: nodeRect.height * ky,
          rotation: pageTarget ? 0 : num(info.node.frame && info.node.frame.rotation, 0),
          pageId: entry.pageId
        };
        renderedSource = rendered;
      }
      if (!box || box.rotation || !entry) return;
      const url = cropMediaUrl(info.node);
      if (!url) return;
      const loader = new Image();
      const begin = function () {
        if (state.destroyed || state.cropSession) return;
        const V = { x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h) };
        let I;
        const existing = currentCrop(info.node);
        if (existing) {
          I = { x: V.x + existing.x * V.w, y: V.y + existing.y * V.h, w: existing.w * V.w, h: existing.h * V.h };
        } else {
          // Default = the "cover" placement the renderer paints without a crop.
          const natW = loader.naturalWidth || V.w;
          const natH = loader.naturalHeight || V.h;
          const scale = Math.max(V.w / natW, V.h / natH);
          I = { w: natW * scale, h: natH * scale };
          I.x = V.x + (V.w - I.w) / 2;
          I.y = V.y + (V.h - I.h) / 2;
        }
        buildCropUi(entry, nodeId, info.node, url, V, I, renderedSource, pageTarget && pageTarget.pageId);
      };
      loader.onload = begin;
      loader.onerror = function () {
        dom.hint.textContent = (globalThis.PlatformLanguage?.text("doc-editor","m_9cfad9b0536b02","Could not load that image for cropping") ?? "Could not load that image for cropping");
        dom.hint.classList.add("show", "warn");
        setTimeout(function () { dom.hint.classList.remove("show", "warn"); }, 2200);
      };
      loader.src = url;
      if (loader.complete && loader.naturalWidth) begin();
    }

    function buildCropUi(entry, nodeId, node, url, V, I, sourceEl, pageId) {
      const ui = el("div", { class: "fmde-cropui" });
      const ghost = el("img", { class: "fmde-crop-ghost", src: url, draggable: "false", alt: "" });
      const solid = el("img", { class: "fmde-crop-solid", src: url, draggable: "false", alt: "" });
      const viewport = el("div", { class: "fmde-crop-viewport" });
      const objectPreview = buildCropObjectPreview(node, sourceEl);
      const imgBox = el("div", { class: "fmde-crop-imgbox", title: (globalThis.PlatformLanguage?.text("doc-editor","m_7138a2b86809af","Drag to reposition — corners zoom") ?? "Drag to reposition — corners zoom") });
      for (const dir of ["nw", "ne", "sw", "se"]) {
        imgBox.appendChild(el("span", { class: "fmde-crop-handle fmde-crop-handle-" + dir, "data-fmde-crop": dir }));
      }
      ui.appendChild(ghost);
      ui.appendChild(solid);
      ui.appendChild(viewport);
      ui.appendChild(objectPreview);
      ui.appendChild(imgBox);
      // The crop ghost deliberately extends beyond the image frame. Temporarily
      // lift the paper clip too, so the complete source remains visible even
      // when the cropped object touches a page edge.
      entry.pageEl.classList.add("fmde-crop-active");
      entry.overlay.appendChild(ui);
      const session = { nodeId: nodeId, node: node, pageId: pageId || null, entry: entry, ui: ui, ghost: ghost, solid: solid, viewport: viewport, objectPreview: objectPreview, imgBox: imgBox, V: V, I: I };
      state.cropSession = session;
      layoutCropUi(session);
      imgBox.addEventListener("pointerdown", function (ev) { onCropPointerDown(session, ev); });
      dom.hint.textContent = (globalThis.PlatformLanguage?.text("doc-editor","m_96b9b75dde1fb2","Drag to reposition · corners zoom · Enter to apply · Esc to cancel") ?? "Drag to reposition · corners zoom · Enter to apply · Esc to cancel");
      dom.hint.classList.remove("warn");
      dom.hint.classList.add("show");
    }

    function layoutCropUi(session) {
      const { V, I } = session;
      const place = function (elm, r) {
        elm.style.left = r.x + "pt";
        elm.style.top = r.y + "pt";
        elm.style.width = Math.max(0, r.w) + "pt";
        elm.style.height = Math.max(0, r.h) + "pt";
      };
      place(session.ghost, I);
      place(session.solid, I);
      place(session.imgBox, I);
      place(session.viewport, V);
      place(session.objectPreview, V);
      const radius = cropPreviewRadius(session.node);
      session.viewport.style.borderRadius = radius;
      session.objectPreview.style.borderRadius = radius;
      // Solid layer: full image clipped to the viewport (inset % of the image box).
      const top = ((V.y - I.y) / I.h) * 100;
      const left = ((V.x - I.x) / I.w) * 100;
      const bottom = ((I.y + I.h - (V.y + V.h)) / I.h) * 100;
      const right = ((I.x + I.w - (V.x + V.w)) / I.w) * 100;
      session.solid.style.clipPath = "inset(" + Math.max(0, top) + "% " + Math.max(0, right) + "% " + Math.max(0, bottom) + "% " + Math.max(0, left) + "% round " + radius + ")";
    }

    /** Keep the viewport covered: the image rect may never expose a gap. */
    function clampCropRect(I, V) {
      I.w = Math.max(V.w, I.w);
      I.h = Math.max(V.h, I.h);
      I.x = Math.min(V.x, Math.max(I.x, V.x + V.w - I.w));
      I.y = Math.min(V.y, Math.max(I.y, V.y + V.h - I.h));
      return I;
    }

    function onCropPointerDown(session, ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const entry = session.entry;
      const handleEl = ev.target.closest ? ev.target.closest("[data-fmde-crop]") : null;
      const dir = handleEl ? handleEl.getAttribute("data-fmde-crop") : null;
      const start = pagePoint(entry, ev);
      const I0 = Object.assign({}, session.I);
      const V = session.V;
      if (!dir) {
        // Pan: translate the image beneath the fixed viewport.
        trackPointer(ev, function (mv) {
          const pt = pagePoint(entry, mv);
          session.I = clampCropRect({
            x: I0.x + (pt.x - start.x),
            y: I0.y + (pt.y - start.y),
            w: I0.w,
            h: I0.h
          }, V);
          layoutCropUi(session);
        }, function () { /* stays in session until commit */ });
        return;
      }
      // Corner zoom: aspect-locked scale anchored at the opposite corner.
      const sx = dir.indexOf("e") !== -1 ? 1 : -1;   // dragged corner direction
      const sy = dir.indexOf("s") !== -1 ? 1 : -1;
      const anchor = {
        x: sx === 1 ? I0.x : I0.x + I0.w,
        y: sy === 1 ? I0.y : I0.y + I0.h
      };
      // Minimum scale that keeps the viewport covered with the anchor fixed.
      const needW = sx === 1 ? (V.x + V.w - anchor.x) : (anchor.x - V.x);
      const needH = sy === 1 ? (V.y + V.h - anchor.y) : (anchor.y - V.y);
      const minScale = Math.max(needW / I0.w, needH / I0.h, 0.01);
      const MAX_CROP_SCALE = 12;
      trackPointer(ev, function (mv) {
        const pt = pagePoint(entry, mv);
        const rawW = (pt.x - anchor.x) * sx;
        const rawH = (pt.y - anchor.y) * sy;
        let scale = Math.max(rawW / I0.w, rawH / I0.h);
        scale = Math.min(MAX_CROP_SCALE, Math.max(minScale, scale));
        const w = I0.w * scale;
        const h = I0.h * scale;
        session.I = clampCropRect({
          x: sx === 1 ? anchor.x : anchor.x - w,
          y: sy === 1 ? anchor.y : anchor.y - h,
          w: w,
          h: h
        }, V);
        layoutCropUi(session);
      }, function () { /* stays in session until commit */ });
    }

    // ---- insert placement ---------------------------------------------------------------------

    function nextZ(pageId) {
      const page = M.findPage(state.doc, pageId);
      let z = 0;
      if (page) for (const node of page.page.children || []) z = Math.max(z, ((node.frame && node.frame.z) || 0) + 1);
      return z;
    }

    function beginPendingInsert(spec) {
      state.pendingInsert = spec;
      dom.canvas.classList.add("fmde-placing");
      dom.hint.textContent = "Click on a page to place " + (spec.label || spec.kind) + " — Esc to cancel";
      dom.hint.classList.add("show");
      dom.hint.classList.remove("warn");
    }

    function cancelPendingInsert() {
      state.pendingInsert = null;
      dom.canvas.classList.remove("fmde-placing");
      dom.hint.classList.remove("show");
    }

    function buildInsertNode(spec, pt, pageId) {
      const z = nextZ(pageId);
      const paper = dims();
      const at = pt || { x: paper.w_pt / 2, y: paper.h_pt / 2 };
      if (spec.kind === "text") {
        return M.createNode("text", {
          name: "Text",
          frame: { x: roundPt(at.x - 90), y: roundPt(at.y - 12), w: 180, h: 26, z: z },
          style: { font: { size_pt: 12, color: "#111827" } },
          props: { blocks: [{ id: M.generateId("blk"), type: "paragraph", align: "left", runs: [{ text: "New text" }] }] }
        });
      }
      if (spec.kind === "frame") {
        return M.createNode("frame", {
          name: "Frame",
          frame: { x: roundPt(at.x - 110), y: roundPt(at.y - 75), w: 220, h: 150, z: z },
          style: { fill: { type: "solid", color: "#F3F4F6" }, radius: [4, 4, 4, 4] }
        });
      }
      if (spec.kind === "image") {
        return M.createNode("image", {
          name: "Image",
          frame: { x: roundPt(at.x - 90), y: roundPt(at.y - 60), w: 180, h: 120, z: z },
          props: { media: spec.media || null, fit: "cover", alt: "" }
        });
      }
      if (spec.kind === "shape") {
        const shape = spec.shape || "rect";
        const base = {
          name: shape.charAt(0).toUpperCase() + shape.slice(1),
          frame: { x: roundPt(at.x - 60), y: roundPt(at.y - 60), w: 120, h: 120, z: z },
          props: { shape: shape, corner_radius: shape === "rect" ? 2 : 0 },
          style: { fill: { type: "solid", color: "var(--fm-primary, #2563EB)" } }
        };
        if (shape === "line") {
          base.frame = { x: roundPt(at.x - 80), y: roundPt(at.y - 1), w: 160, h: 2, z: z };
          base.props.points = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
          base.style = { stroke: { color: "#111827", width_pt: 2 }, fill: null };
        }
        if (shape === "polygon") {
          base.props.points = [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
        }
        return M.createNode("shape", base);
      }
      if (spec.kind === "widget" && spec.widget) {
        const def = spec.widget;
        const defaults = def.defaults || {};
        const frame = Object.assign({ w: 300, h: 120 }, defaults.frame || {});
        return M.createNode("widget", {
          name: def.title || def.id,
          frame: { x: roundPt(at.x - frame.w / 2), y: roundPt(at.y - frame.h / 2), w: frame.w, h: frame.h, z: z },
          props: { widget: def.id + "@" + (def.version || 1), config: M.deepClone(defaults.config || {}), object_layout: "flow" }
        });
      }
      return null;
    }

    /** The section (top-level band) containing a page-space point. */
    function sectionAtPoint(pt) {
      const sections = viewSections();
      for (const section of sections) {
        const box = overlayBox(section.id);
        if (!box || !Number.isFinite(box.y)) continue;
        if (pt.y >= box.y && pt.y <= box.y + box.h) return { section: section, box: box };
      }
      const last = sections[sections.length - 1];
      if (!last) return null;
      const box = overlayBox(last.id);
      return box ? { section: last, box: box } : null;
    }

    function placePendingInsert(entry, pt) {
      const spec = state.pendingInsert;
      cancelPendingInsert();
      if (!spec) return;
      // View docs drop INTO the section under the cursor, in section-relative
      // coordinates — appending to the page root would land the node at the
      // bottom of the flow column, far from where it was dropped.
      const target = isViewDoc() ? sectionAtPoint(pt) : null;
      const localPt = target ? { x: pt.x - target.box.x, y: pt.y - target.box.y } : pt;
      if (spec.kind === "image" && opts.media && typeof opts.media.pick === "function" && !spec.media) {
        Promise.resolve(opts.media.pick()).then(function (mediaRef) {
          if (!mediaRef) return;
          const node = buildInsertNode(Object.assign({}, spec, { media: mediaRef }), localPt, entry.pageId);
          insertBuiltNode(node, entry.pageId, target);
        }).catch(function () { /* host cancelled the picker */ });
        return;
      }
      const node = buildInsertNode(spec, localPt, entry.pageId);
      insertBuiltNode(node, entry.pageId, target);
    }

    function insertBuiltNode(node, pageId, target) {
      if (!node) return;
      const cmd = { type: "node.insert", node: node, page_id: pageId };
      if (node.type === "widget" && node.props && node.props.object_layout === "flow" && !isViewDoc()) {
        const flowFrame = defaultWidgetFlowFrame();
        if (flowFrame) {
          node.anchor = "flow";
          node.frame = Object.assign({}, node.frame, { x: 0, y: 0, z: 0, layout: "flow" });
          cmd.parent_id = flowFrame.id;
          cmd.page_id = null;
          cmd.index = (flowFrame.children || []).length;
          target = null;
        }
      }
      if (target && target.section) {
        cmd.parent_id = target.section.id;
        cmd.page_id = null;
        // Land on top of everything already in that section.
        let topZ = 0;
        for (const sib of (target.section.children || [])) topZ = Math.max(topZ, num(sib.frame && sib.frame.z, 0));
        node.frame = Object.assign({}, node.frame, { z: topZ + 1 });
        // Keep the drop inside the section's bounds.
        const maxY = Math.max(0, roundPt(target.box.h - num(node.frame.h, 0)));
        node.frame.y = clamp(num(node.frame.y, 0), 0, maxY);
        node.frame.x = Math.max(0, num(node.frame.x, 0));
        node.frame = responsivePositionForFrame(node.frame, target.section.id, { unit: "percent", anchor: "center", value: 0 });
      }
      const result = runCommands([cmd], "insert");
      if (result.ok) {
        state.currentPageId = pageId;
        setSelection([node.id]);
      }
    }

    // ---- clipboard / duplicate / delete ------------------------------------------------------

    function copySelection() {
      if (!state.selection.length) return;
      const nodes = [];
      const placements = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (info) {
          nodes.push(M.deepClone(info.node));
          placements.push({ parentId: info.parentId || null, pageId: info.pageId || null, index: info.index });
        }
      }
      if (nodes.length) {
        state.clipboard = { nodes: nodes, placements: placements, pageId: state.currentPageId };
        state.pasteCount = 0;
      }
    }

    function pasteClipboard() {
      if (!state.clipboard || !state.clipboard.nodes.length) return;
      const pageId = state.currentPageId || (state.doc.pages && state.doc.pages[0] && state.doc.pages[0].id) || null;
      if (!pageId && !isViewDoc()) return;
      state.pasteCount += 1;
      const offset = DUPLICATE_OFFSET_PT * state.pasteCount;
      const commands = [];
      const newIds = [];
      for (let sourceIndex = 0; sourceIndex < state.clipboard.nodes.length; sourceIndex += 1) {
        const source = state.clipboard.nodes[sourceIndex];
        const placement = state.clipboard.placements && state.clipboard.placements[sourceIndex] || {};
        const clone = M.reassignIds(source);
        clone.frame = Object.assign({}, clone.frame, {
          x: roundPt((clone.frame.x || 0) + offset),
          y: roundPt((clone.frame.y || 0) + offset),
          z: pageId ? nextZ(pageId) + commands.length : num(clone.frame && clone.frame.z, 0) + 1
        });
        if (isViewDoc() && placement.parentId) clone.frame = responsivePositionForFrame(clone.frame, placement.parentId, source.frame && source.frame.position && source.frame.position.x);
        newIds.push(clone.id);
        commands.push({ type: "node.insert", node: clone, parent_id: isViewDoc() ? placement.parentId : null, page_id: pageId });
      }
      const result = runCommands(commands, "paste");
      if (result.ok) setSelection(newIds);
    }

    function duplicateSelection() {
      if (!state.selection.length) return;
      const commands = [];
      const newIds = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (!info) continue;
        const clone = M.reassignIds(info.node);
        clone.frame = Object.assign({}, clone.frame, {
          x: roundPt((clone.frame.x || 0) + DUPLICATE_OFFSET_PT),
          y: roundPt((clone.frame.y || 0) + DUPLICATE_OFFSET_PT),
          z: info.pageId ? nextZ(info.pageId) + commands.length : ((clone.frame.z || 0) + 1)
        });
        if (isViewDoc() && info.parentId) clone.frame = responsivePositionForFrame(clone.frame, info.parentId, info.node.frame && info.node.frame.position && info.node.frame.position.x);
        newIds.push(clone.id);
        commands.push({ type: "node.insert", node: clone, parent_id: info.parentId, page_id: info.pageId, index: info.index + 1 });
      }
      if (!commands.length) return;
      const result = runCommands(commands, "duplicate");
      if (result.ok) setSelection(newIds);
    }

    function deleteSelection() {
      if (!state.selection.length) return;
      const commands = state.selection.map(function (id) {
        return { type: "node.remove", node_id: id };
      });
      const result = runCommands(commands, "delete");
      if (result.ok) setSelection([]);
    }

    function nudgeSelection(dx, dy) {
      const commands = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (!info || !nodeMovable(info.node)) continue;
        const currentFrame = gestureFrame(info.node);
        const frame = Object.assign({}, currentFrame, {
          x: roundPt((currentFrame.x || 0) + dx),
          y: roundPt((currentFrame.y || 0) + dy)
        });
        commands.push({ type: "node.set", node_id: id, prop: "frame", value: responsiveFramePosition(id, frame) });
      }
      if (commands.length) runCommands(commands, "nudge");
    }

    // ---- grouping / z-order / align ---------------------------------------------------------

    function groupSelection() {
      if (state.selection.length < 2) return;
      const entries = state.selection.map(function (id) {
        const info = state.nodeIndex.get(id);
        const box = overlayBox(id);
        return info && box && nodeMovable(info.node) ? { id: id, info: info, box: box } : null;
      }).filter(Boolean);
      if (entries.length !== state.selection.length) { flashReason("selection_contains_immovable_item"); return; }
      const pageIds = Array.from(new Set(entries.map(function (entry) { return entry.box.pageId || entry.info.pageId || ""; })));
      if (pageIds.length !== 1) { flashReason("group_requires_one_page"); return; }
      const firstParent = entries[0].info.parentId || null;
      const alreadySiblings = entries.every(function (entry) { return (entry.info.parentId || null) === firstParent; });
      const normalizeToPage = state.mode === "doc" || !alreadySiblings;
      const commands = [];
      const memberFrames = {};
      if (normalizeToPage) {
        const targetParentId = isViewDoc() ? state.doc.root.id : null;
        const targetPageId = isViewDoc() ? null : entries[0].info.pageId;
        for (const entry of entries) {
          const frame = Object.assign({}, entry.info.node.frame, {
            x: roundPt(entry.box.x), y: roundPt(entry.box.y),
            w: roundPt(entry.box.w), h: roundPt(entry.box.h), layout: "absolute"
          });
          if (isViewDoc()) frame.__fmde_rendered_responsive = true;
          memberFrames[entry.id] = isViewDoc()
            ? responsiveFramePosition(entry.id, frame, targetParentId)
            : frame;
          if (entry.info.node.type === "widget") commands.push({ type: "node.set", node_id: entry.id, prop: "props.object_layout", value: "front" });
          commands.push({ type: "node.set_anchor", node_id: entry.id, anchor: "page" });
          commands.push({ type: "node.move", node_id: entry.id, parent_id: targetParentId, page_id: targetPageId, frame: frame });
        }
      } else {
        for (const entry of entries) {
          memberFrames[entry.id] = responsiveFramePosition(entry.id, gestureFrame(entry.info.node));
        }
      }
      commands.push({
        type: "node.group",
        node_ids: state.selection.slice(),
        member_frames: memberFrames,
        parent_width_pt: isViewDoc() ? responsiveAuthoredParentWidthPt(normalizeToPage ? state.doc.root.id : firstParent) : undefined
      });
      const result = runCommands(commands, "group");
      const groupResult = result.ok && result.results && result.results.slice().reverse().find(function (entry) { return entry && entry.node_id; });
      if (groupResult && groupResult.node_id) {
        setSelection([groupResult.node_id]);
      }
    }

    function startStructuralSectionWidthResize(entry, downEv, dir, nodeId) {
      const info = state.nodeIndex.get(nodeId);
      if (!info || !nodeResizable(info.node)) return;
      const sectionEl = renderedNodeElement(nodeId);
      const parentEl = sectionEl && sectionEl.parentElement;
      if (!sectionEl || !parentEl) return;
      const startRect = sectionEl.getBoundingClientRect();
      const parentRect = parentEl.getBoundingClientRect();
      if (!(startRect.width > 0) || !(parentRect.width > 0)) return;
      const screenScale = Math.max(0.01, state.zoom || 1);
      // One width authority: the visible canvas after editor rails, palettes,
      // inspectors, and the standard canvas gutters. Never derive section
      // sizing from a parent/page design width.
      const availableScreenWidth = currentViewSurfaceWidth();
      const startX = downEv.clientX;
      const direction = dir === "w" ? -1 : 1;
      const startSizing = M.normalizeSectionWidth(info.node.props && info.node.props.section_width);
      const otherWidths = [];
      for (const section of state.doc && state.doc.root && state.doc.root.children || []) {
        if (!section || section.id === nodeId) continue;
        const otherEl = renderedNodeElement(section.id);
        const rect = otherEl && otherEl.getBoundingClientRect();
        if (rect && rect.width > 0) otherWidths.push(rect.width);
      }
      const originalBox = overlayBox(nodeId);
      const boxEl = state.selBoxes.get(nodeId);
      const chromeRoot = dom.root.closest ? dom.root.closest(".fmve-chrome") : null;
      let lastSizing = null;
      let moved = false;
      trackPointer(downEv, function (ev) {
        let width = startRect.width + (ev.clientX - startX) * direction * 2;
        const percentLimit = availableScreenWidth * startSizing.width_percent / 100;
        const minWidth = Math.max(24, Math.min(percentLimit, 160));
        const maxWidth = percentLimit;
        width = clamp(width, minWidth, maxWidth);
        let snapped = false;
        if (!ev.altKey) {
          const unsnappedWidth = width;
          let snapDistance = SECTION_WIDTH_SNAP_TOLERANCE_PX + 1;
          for (const candidate of otherWidths) {
            const distance = Math.abs(candidate - unsnappedWidth);
            if (candidate >= minWidth && candidate <= maxWidth && distance <= SECTION_WIDTH_SNAP_TOLERANCE_PX && distance < snapDistance) {
              width = candidate;
              snapped = true;
              snapDistance = distance;
            }
          }
        }
        width = clamp(width, minWidth, maxWidth);
        moved = true;
        lastSizing = M.normalizeSectionWidth(Object.assign({}, startSizing, {
          max_enabled: true,
          max_width_px: width
        }));
        // Renderer section dimensions are unscaled CSS pixels inside the
        // transformed view surface; compensate so the gesture previews the
        // exact final screen-pixel width.
        sectionEl.style.width = width / screenScale + "px";
        sectionEl.style.maxWidth = lastSizing.max_enabled ? lastSizing.max_width_px / screenScale + "px" : "";
        sectionEl.style.alignSelf = "center";
        sectionEl.style.marginLeft = "";
        sectionEl.style.marginRight = "";
        // If the side width pop-up is open, its readout follows the handle in
        // real time even though the undoable model command is committed once
        // at pointer-up.
        if (chromeRoot) {
          const widthOutput = chromeRoot.querySelector("[data-ch-sec-width-value]");
          const widthRange = chromeRoot.querySelector("[data-ch-sec-width-range]");
          const maxOutput = chromeRoot.querySelector("[data-ch-sec-max-value]");
          const maxRange = chromeRoot.querySelector("[data-ch-sec-max-range]");
          const maxToggle = chromeRoot.querySelector("[data-ch-sec-max-toggle]");
          const maxRow = chromeRoot.querySelector("[data-ch-sec-max-row]");
          if (widthOutput) widthOutput.textContent = lastSizing.width_percent + "%";
          if (widthRange) widthRange.value = String(lastSizing.width_percent);
          if (maxOutput) maxOutput.textContent = lastSizing.max_width_px + "px";
          if (maxRange) maxRange.value = String(lastSizing.max_width_px);
          if (maxToggle) {
            maxToggle.classList.add("active");
            maxToggle.setAttribute("aria-checked", "true");
          }
          if (maxRow) maxRow.classList.remove("disabled");
        }
        if (boxEl && originalBox) {
          const widthPt = width * (entry.ptPerPx || 1);
          const leftPt = originalBox.x + (originalBox.w - widthPt) / 2;
          boxEl.style.left = leftPt + "pt";
          boxEl.style.width = widthPt + "pt";
          showGuides(entry, { vLine: snapped ? leftPt + widthPt : null, hLine: null });
        }
      }, function () {
        clearGuides();
        if (!moved || !lastSizing) return;
        runCommands([{ type: "node.set", node_id: nodeId, prop: "props.section_width", value: lastSizing }], "resize section width");
      });
    }

    function ungroupSelection() {
      const groups = state.selection.map(function (id) { return state.nodeIndex.get(id); }).filter(function (info) { return info && isGroupNode(info.node); });
      if (!groups.length) return;
      const childIds = [];
      const commands = groups.map(function (info) {
        for (const child of info.node.children || []) childIds.push(child.id);
        const memberFrames = {};
        for (const child of info.node.children || []) memberFrames[child.id] = M.deepClone(child.frame || {});
        return {
          type: "node.ungroup", node_id: info.node.id,
          group_frame: M.deepClone(info.node.frame || {}), member_frames: memberFrames,
          parent_width_pt: isViewDoc() ? responsiveAuthoredParentWidthPt(info.parentId || state.doc.root.id) : undefined
        };
      });
      const result = runCommands(commands, "ungroup");
      if (result.ok) setSelection(childIds);
    }

    function removeMemberFromGroup(memberId, groupId) {
      const memberInfo = state.nodeIndex.get(memberId);
      const groupInfo = state.nodeIndex.get(groupId);
      if (!memberInfo || !groupInfo || memberInfo.parentId !== groupId || !isGroupNode(groupInfo.node)) return;
      const child = memberInfo.node;
      const group = groupInfo.node;
      const gf = group.frame || {};
      const cf = child.frame || {};
      const grot = num(gf.rotation, 0);
      const w = num(cf.w, 0);
      const h = num(cf.h, 0);
      const gcx = num(gf.x, 0) + num(gf.w, 0) / 2;
      const gcy = num(gf.y, 0) + num(gf.h, 0) / 2;
      let cx = num(gf.x, 0) + num(cf.x, 0) + w / 2;
      let cy = num(gf.y, 0) + num(cf.y, 0) + h / 2;
      if (grot) {
        const absolute = M.rotatePoint(cx, cy, gcx, gcy, grot);
        cx = absolute.x; cy = absolute.y;
      }
      const frame = Object.assign({}, cf, {
        x: roundPt(cx - w / 2),
        y: roundPt(cy - h / 2),
        rotation: roundPt(num(cf.rotation, 0) + grot)
      });
      const commands = [{
        type: "node.move", node_id: memberId, parent_id: groupInfo.parentId || null,
        page_id: groupInfo.pageId || null, index: groupInfo.index + 1, frame: frame
      }];
      // A one-member wrapper is no longer useful as a group. Dissolve it in
      // the same undoable transaction when removing from a two-member group.
      if ((group.children || []).length === 2) commands.push({ type: "node.ungroup", node_id: groupId });
      const result = runCommands(commands, "remove-from-group");
      if (result.ok) setSelection([memberId]);
    }

    function reorderSelection(mode) {
      if (!state.selection.length) return;
      const commands = state.selection.filter(function (id) { return !isStructuralSection(id); }).map(function (id) {
        return { type: "node.reorder", node_id: id, mode: mode };
      });
      if (!commands.length) return;
      runCommands(commands, "reorder");
    }

    function alignSelection(mode) {
      const items = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (!info || !nodeMovable(info.node)) continue;
        const frame = gestureFrame(info.node);
        items.push({ id: id, frame: frame, bounds: M.frameBounds(frame) });
      }
      if (items.length < 2) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const item of items) {
        minX = Math.min(minX, item.bounds.x);
        minY = Math.min(minY, item.bounds.y);
        maxX = Math.max(maxX, item.bounds.x + item.bounds.w);
        maxY = Math.max(maxY, item.bounds.y + item.bounds.h);
      }
      const commands = [];
      for (const item of items) {
        const b = item.bounds;
        const offX = item.frame.x - b.x;
        const offY = item.frame.y - b.y;
        let bx = b.x, by = b.y;
        if (mode === "left") bx = minX;
        else if (mode === "hcenter") bx = (minX + maxX) / 2 - b.w / 2;
        else if (mode === "right") bx = maxX - b.w;
        else if (mode === "top") by = minY;
        else if (mode === "vcenter") by = (minY + maxY) / 2 - b.h / 2;
        else if (mode === "bottom") by = maxY - b.h;
        const frame = Object.assign({}, item.frame, { x: roundPt(bx + offX), y: roundPt(by + offY) });
        if (frame.x !== item.frame.x || frame.y !== item.frame.y) {
          commands.push({ type: "node.set", node_id: item.id, prop: "frame", value: responsiveFramePosition(item.id, frame) });
        }
      }
      if (commands.length) runCommands(commands, "align");
    }

    function distributeSelection(axis) {
      const items = [];
      for (const id of state.selection) {
        const info = state.nodeIndex.get(id);
        if (!info || !nodeMovable(info.node)) continue;
        const frame = gestureFrame(info.node);
        items.push({ id: id, frame: frame, bounds: M.frameBounds(frame) });
      }
      if (items.length < 3) return;
      const key = axis === "h" ? "x" : "y";
      const size = axis === "h" ? "w" : "h";
      items.sort(function (a, b) {
        return (a.bounds[key] + a.bounds[size] / 2) - (b.bounds[key] + b.bounds[size] / 2);
      });
      const first = items[0];
      const last = items[items.length - 1];
      const span = (last.bounds[key] + last.bounds[size] / 2) - (first.bounds[key] + first.bounds[size] / 2);
      if (span <= 0) return;
      const step = span / (items.length - 1);
      const commands = [];
      for (let i = 1; i < items.length - 1; i += 1) {
        const item = items[i];
        const targetCenter = first.bounds[key] + first.bounds[size] / 2 + step * i;
        const delta = targetCenter - (item.bounds[key] + item.bounds[size] / 2);
        if (Math.abs(delta) < 0.01) continue;
        const frame = Object.assign({}, item.frame);
        frame[key] = roundPt(item.frame[key] + delta);
        commands.push({ type: "node.set", node_id: item.id, prop: "frame", value: responsiveFramePosition(item.id, frame) });
      }
      if (commands.length) runCommands(commands, "distribute");
    }

    // ---- keyboard -----------------------------------------------------------------------------

    function isFormTarget(target) {
      if (!target) return false;
      const tag = (target.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
    }

    function fontSizeShortcutDirection(ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return 0;
      if (ev.key === ">" || (ev.shiftKey && ev.code === "Period")) return 1;
      if (ev.key === "<" || (ev.shiftKey && ev.code === "Comma")) return -1;
      return 0;
    }

    function onKeyDown(ev) {
      if (state.destroyed) return;
      const meta = ev.ctrlKey || ev.metaKey;
      if (state.cropSession) {
        if (ev.key === "Escape") { ev.preventDefault(); cancelCropSession(); }
        else if (ev.key === "Enter") { ev.preventDefault(); commitCropSession(); }
        return;
      }
      const fontSizeDirection = fontSizeShortcutDirection(ev);
      if (fontSizeDirection && state.mode === "visual") {
        const context = visualTextContext();
        if (context) {
          ev.preventDefault();
          if (state.textEditing && state.textEditing.editable) {
            const session = state.textEditing;
            const current = num(session.fontSize, num(root.getComputedStyle(session.editable).fontSize, 14.67) * 72 / 96);
            session.fontSize = clamp(Math.round(current + fontSizeDirection), 4, 96);
            session.editable.style.fontSize = session.fontSize + "pt";
            if (session.liveLabel) session.liveLabel.style.fontSize = session.fontSize + "pt";
          } else {
            const value = visualTextState(context);
            if (value) setVisualTextValue("size_pt", clamp(Math.round(value.size + fontSizeDirection), 4, 96));
          }
          return;
        }
      }
      if (state.textEditing) {
        if (ev.key === "Escape") {
          ev.preventDefault();
          commitTextEdit();
        }
        return;
      }
      if (!meta && !ev.altKey && !isFormTarget(ev.target) && state.selection.length === 1) {
        const selected = state.nodeIndex.get(state.selection[0]);
        const startsShapeText = selected && selected.node && selected.node.type === "shape" && (ev.key.length === 1 || ev.key === "Enter");
        if (startsShapeText) {
          ev.preventDefault();
          startShapeTextEdit(selected.node.id, ev.key === "Enter" ? undefined : ev.key);
          return;
        }
      }
      if (state.mode === "doc") {
        // Word-processor surface: selected document objects own Delete, while
        // inputs and contenteditable text retain normal character deletion.
        if ((ev.key === "Delete" || ev.key === "Backspace") && !isFormTarget(ev.target)) {
          if (state.imageFocus) {
            ev.preventDefault();
            const imageId = state.imageFocus;
            clearDocImageSelection();
            runCommands([{ type: "node.remove", node_id: imageId }], "image:delete-key");
            return;
          }
          if (state.docKeyboardObjectId && state.selection.indexOf(state.docKeyboardObjectId) !== -1) {
            ev.preventDefault();
            deleteSelection();
            return;
          }
        }
        // Undo must be ours even inside the contenteditable projection.
        if (ev.altKey && ev.key === "/") { ev.preventDefault(); showMenuSearch(dom.menuSearch, dom.menuDefinitions || []); return; }
        if (meta && (ev.key === "h" || ev.key === "H")) { ev.preventDefault(); showFindReplace(); return; }
        if (meta && !ev.shiftKey && !ev.altKey && (ev.key === "f" || ev.key === "F")) { ev.preventDefault(); showFindReplace(); return; }
        if (meta && ev.shiftKey && (ev.key === "c" || ev.key === "C")) { ev.preventDefault(); showWordCount(); return; }
        if (meta && ev.key === "/") { ev.preventDefault(); showKeyboardShortcuts(); return; }
        if (meta && (ev.key === "k" || ev.key === "K")) { ev.preventDefault(); showLinkDialog(); return; }
        if (meta && (ev.key === "p" || ev.key === "P")) { ev.preventDefault(); if (root.print) root.print(); return; }
        if (meta && (ev.key === "o" || ev.key === "O")) { ev.preventDefault(); invokeDocumentAction("open"); return; }
        if (meta && ev.altKey && (ev.key === "m" || ev.key === "M")) { ev.preventDefault(); const comment = dom.toolbar.querySelector('button[title="Add comment"]'); if (comment) comment.click(); return; }
        if (meta && ev.altKey && (ev.key === "f" || ev.key === "F")) { ev.preventDefault(); insertFootnote(); return; }
        if (ev.key === "Tab" && ev.target && ev.target.closest && ev.target.closest("td[data-cell], th[data-cell]")) {
          // Docs parity: Tab moves between table cells.
          ev.preventDefault();
          moveTableCellFocus(ev.target, ev.shiftKey ? -1 : 1);
          return;
        }
        if (ev.key === "Tab" && ev.target && ev.target.closest && ev.target.closest(".fmde-docedit")) {
          ev.preventDefault();
          const delta = ev.shiftKey ? -1 : 1;
          docProjection.mutateCoveredBlocks(delta > 0 ? "indent" : "outdent", function (block) {
            block.indent = clamp(Number(block.indent || 0) + delta, 0, 8);
            if (!block.indent) delete block.indent;
          });
          return;
        }
        if (meta && ev.key === "Enter" && ev.target && ev.target.closest && ev.target.closest(".fmde-docedit")) {
          ev.preventDefault();
          docProjection.insertPageBreak();
          return;
        }
        if (meta && (ev.key === "z" || ev.key === "Z")) {
          ev.preventDefault();
          if (ev.shiftKey) performRedo();
          else performUndo();
          return;
        }
        if (meta && (ev.key === "y" || ev.key === "Y")) {
          ev.preventDefault();
          performRedo();
          return;
        }
        if (meta && ev.shiftKey && ["l","e","r","j"].includes(ev.key.toLowerCase())) {
          ev.preventDefault(); const align = { l:"left", e:"center", r:"right", j:"justify" }[ev.key.toLowerCase()];
          docProjection.mutateCoveredBlocks("align-text", function (block) { block.align = align; }); return;
        }
        if (meta && ev.shiftKey && (ev.code === "Digit7" || ev.code === "Digit8" || ev.key === "7" || ev.key === "8")) {
          // ev.code: with Shift held the key VALUE becomes "&"/"*" on US layouts.
          ev.preventDefault(); const style = (ev.code === "Digit7" || ev.key === "7") ? "number" : "bullet";
          docProjection.mutateCoveredBlocks("list", function (block) { const same = block.type === "list_item" && block.list_style === style; block.type = same ? "paragraph" : "list_item"; if (same) delete block.list_style; else block.list_style = style; }); return;
        }
        if (fontSizeDirection) {
          ev.preventDefault(); const current = num(state.typingFormat.size_pt, num(state.doc.settings && state.doc.settings.base_font_pt, 11)); docProjection.format("fontSize", clamp(current + fontSizeDirection, 6, 96)); return;
        }
        if (meta && ev.key === "\\") { ev.preventDefault(); docProjection.format("removeFormat"); docProjection.applyStyleRef(null); return; }
        if (ev.altKey && ev.shiftKey && (ev.code === "Digit5" || ev.key === "5" || ev.key === "%")) { ev.preventDefault(); docProjection.format("strikeThrough"); return; }
        if (meta && !ev.shiftKey && !ev.altKey && (ev.code === "Period" || ev.key === ".")) { ev.preventDefault(); docProjection.format("superscript"); return; }
        if (meta && !ev.shiftKey && !ev.altKey && (ev.code === "Comma" || ev.key === ",")) { ev.preventDefault(); docProjection.format("subscript"); return; }
        if (meta && (ev.key === "b" || ev.key === "B")) { ev.preventDefault(); docProjection.format("bold"); return; }
        if (meta && (ev.key === "i" || ev.key === "I")) { ev.preventDefault(); docProjection.format("italic"); return; }
        if (meta && (ev.key === "u" || ev.key === "U")) { ev.preventDefault(); docProjection.format("underline"); return; }
        if (ev.key === "Escape") {
          docProjection.commitNow("escape");
          const active = document.activeElement;
          if (active && active.blur && dom.root.contains(active)) active.blur();
        }
        return;
      }
      if (state.mode === "preview") return;
      if (isFormTarget(ev.target)) {
        if (ev.key === "Escape" && ev.target.blur) ev.target.blur();
        return;
      }
      if (meta && (ev.key === "z" || ev.key === "Z")) {
        ev.preventDefault();
        if (ev.shiftKey) performRedo();
        else performUndo();
        return;
      }
      if (meta && (ev.key === "y" || ev.key === "Y")) {
        ev.preventDefault();
        performRedo();
        return;
      }
      if (meta && (ev.key === "d" || ev.key === "D")) {
        ev.preventDefault();
        duplicateSelection();
        return;
      }
      if (meta && (ev.key === "g" || ev.key === "G")) {
        ev.preventDefault();
        if (ev.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (meta && (ev.key === "c" || ev.key === "C")) { copySelection(); return; }
      if (meta && (ev.key === "x" || ev.key === "X")) { copySelection(); deleteSelection(); return; }
      if (meta && (ev.key === "v" || ev.key === "V")) { pasteClipboard(); return; }
      if (ev.key === "Delete" || ev.key === "Backspace") {
        if (state.selection.length) {
          ev.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (ev.key === "Escape") {
        if (state.pendingInsert) { cancelPendingInsert(); return; }
        if (state.selection.length) { setSelection([]); return; }
        if (state.enterFrameId) { state.enterFrameId = null; return; }
        return;
      }
      const step = ev.shiftKey ? NUDGE_BIG_PT : NUDGE_PT;
      if (ev.key === "ArrowLeft") { ev.preventDefault(); nudgeSelection(-step, 0); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); nudgeSelection(step, 0); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); nudgeSelection(0, -step); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); nudgeSelection(0, step); }
    }

    // ---- in-place text editing -----------------------------------------------------------------

    function runStyleCss(run) {
      const css = [];
      if (run.weight && Number(run.weight) >= 600) css.push("font-weight:" + run.weight);
      else if (run.weight) css.push("font-weight:" + run.weight);
      if (run.italic) css.push("font-style:italic");
      const deco = [];
      if (run.underline) deco.push("underline");
      if (run.strike) deco.push("line-through");
      if (deco.length) css.push("text-decoration:" + deco.join(" "));
      if (run.color) css.push("color:" + run.color);
      if (run.background) css.push("background-color:" + run.background);
      if (run.font && run.font.size_pt) css.push("font-size:" + run.font.size_pt + "pt");
      if (run.font && run.font.family) css.push("font-family:'" + String(run.font.family).replace(/'/g, "") + "'");
      return css.join(";");
    }

    function blocksToHtml(blocks) {
      const html = [];
      for (const block of blocks || []) {
        const align = block.align && block.align !== "left" ? ' style="text-align:' + esc(block.align) + '"' : "";
        const runs = (block.runs || []).map(function (run) {
          const text = esc(run.text || "").replace(/\n/g, "<br>");
          const css = runStyleCss(run);
          return css ? '<span style="' + esc(css) + '">' + text + "</span>" : text;
        }).join("");
        html.push("<div" + align + ">" + (runs || "<br>") + "</div>");
      }
      return html.join("") || "<div><br></div>";
    }

    function parseInlineStyles(node, inherited) {
      const style = Object.assign({}, inherited);
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "b" || tag === "strong") style.weight = 700;
      if (tag === "i" || tag === "em") style.italic = true;
      if (tag === "u") style.underline = true;
      if (tag === "s" || tag === "strike" || tag === "del") style.strike = true;
      if (tag === "sup") { style.super = true; delete style.sub; }
      if (tag === "sub") { style.sub = true; delete style.super; }
      if (tag === "font" && node.getAttribute("color")) style.color = node.getAttribute("color");
      if (tag === "font" && node.getAttribute("face")) style.family = canonicalFontFamily(node.getAttribute("face"));
      if (tag === "a" && node.getAttribute("href")) style.link = node.getAttribute("href");
      const inline = node.style;
      if (inline) {
        if (inline.fontWeight) {
          const w = inline.fontWeight === "bold" ? 700 : inline.fontWeight === "normal" ? 400 : parseInt(inline.fontWeight, 10);
          if (Number.isFinite(w)) style.weight = w;
        }
        if (inline.fontStyle === "italic") style.italic = true;
        if (inline.fontStyle === "normal") delete style.italic;
        if (inline.textDecoration || inline.textDecorationLine) {
          const deco = String(inline.textDecoration || inline.textDecorationLine);
          if (deco.indexOf("underline") !== -1) style.underline = true;
          if (deco.indexOf("line-through") !== -1) style.strike = true;
          if (deco.indexOf("none") !== -1) { delete style.underline; delete style.strike; }
        }
        if (inline.color) style.color = inline.color;
        if (inline.backgroundColor) style.background = inline.backgroundColor;
        if (inline.fontSize) {
          const m = /^([\d.]+)(pt|px)$/.exec(inline.fontSize);
          if (m) style.size_pt = m[2] === "pt" ? parseFloat(m[1]) : roundPt(parseFloat(m[1]) * (72 / 96));
        }
        if (inline.fontFamily) style.family = canonicalFontFamily(inline.fontFamily);
        if (inline.verticalAlign === "super") { style.super = true; delete style.sub; }
        if (inline.verticalAlign === "sub") { style.sub = true; delete style.super; }
        if (inline.verticalAlign === "baseline") { delete style.super; delete style.sub; }
      }
      return style;
    }

    /** Keep model colors in one notation: computed styles come back as
     *  rgb(...), while palette picks are hex — normalize both to hex. */
    function normalizeRunColor(value) {
      const text = String(value || "").trim();
      const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
      if (!m) return text;
      if (m[4] !== undefined && Number(m[4]) === 0) return "transparent";
      const hex = function (n) { return Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0"); };
      return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
    }

    function styleToRun(text, style) {
      const run = { text: text };
      if (style.weight && style.weight !== 400) run.weight = style.weight;
      if (style.italic) run.italic = true;
      if (style.underline) run.underline = true;
      if (style.strike) run.strike = true;
      if (style.super) run.super = true;
      if (style.sub) run.sub = true;
      if (style.color) run.color = normalizeRunColor(style.color);
      if (style.background) run.background = normalizeRunColor(style.background);
      if (style.link) run.link = style.link;
      if (style.size_pt || style.family) {
        run.font = {};
        if (style.family) run.font.family = canonicalFontFamily(style.family);
        if (style.size_pt) run.font.size_pt = style.size_pt;
      }
      return run;
    }

    function sameRunStyle(a, b) {
      return (a.weight || 400) === (b.weight || 400) && !a.italic === !b.italic &&
        !a.underline === !b.underline && !a.strike === !b.strike &&
        !a.super === !b.super && !a.sub === !b.sub &&
        (a.color || "") === (b.color || "") &&
        (a.background || "") === (b.background || "") && (a.link || "") === (b.link || "") &&
        JSON.stringify(a.font || null) === JSON.stringify(b.font || null);
    }

    function collectRuns(container, style, runs, skip) {
      for (const child of Array.prototype.slice.call(container.childNodes)) {
        if (child.nodeType === 3) {
          // execCommand formatting wraps typed spaces as &nbsp; at inline
          // boundaries — store them as plain spaces so text stays searchable.
          const text = (child.nodeValue || "").replace(/ /g, " ");
          if (!text) continue;
          const run = styleToRun(text, style);
          const prev = runs[runs.length - 1];
          if (prev && sameRunStyle(prev, run)) prev.text += text;
          else runs.push(run);
        } else if (child.nodeType === 1) {
          if (skip && skip(child)) continue;
          if ((child.tagName || "").toLowerCase() === "br") {
            const prev = runs[runs.length - 1];
            if (prev) prev.text += "\n";
            else runs.push(styleToRun("\n", style));
            continue;
          }
          collectRuns(child, parseInlineStyles(child, style), runs, skip);
        }
      }
    }

    function htmlToBlocks(editable, originalBlocks) {
      const blocks = [];
      const children = Array.prototype.slice.call(editable.childNodes);
      const blockEls = [];
      let loose = null;
      for (const child of children) {
        const tag = child.nodeType === 1 ? (child.tagName || "").toLowerCase() : "";
        if (tag === "div" || tag === "p" || tag === "li") {
          if (loose) { blockEls.push(loose); loose = null; }
          blockEls.push(child);
        } else {
          if (!loose) {
            loose = document.createElement("div");
          }
          loose.appendChild(child.cloneNode(true));
        }
      }
      if (loose) blockEls.push(loose);
      if (!blockEls.length) blockEls.push(editable);
      for (let i = 0; i < blockEls.length; i += 1) {
        const blockEl = blockEls[i];
        const runs = [];
        collectRuns(blockEl, {}, runs);
        const cleaned = runs.filter(function (run) { return run.text !== ""; });
        const orig = (originalBlocks || [])[i] || {};
        const align = blockEl.style && blockEl.style.textAlign ? blockEl.style.textAlign : orig.align || "left";
        blocks.push({
          id: orig.id || M.generateId("blk"),
          type: orig.type || "paragraph",
          align: align,
          runs: cleaned.length ? cleaned : [{ text: "" }]
        });
      }
      return blocks;
    }

    function startTextEdit(nodeId) {
      if (state.mode !== "visual") return; // doc mode edits through the projection
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info || info.node.type !== "text") return;
      if (lockBlocked(info.node, "content")) { flashReason("locked:content"); return; }
      if (state.textEditing) commitTextEdit();
      const box = overlayBox(info.node.id);
      if (!box) return;
      const entry = entryForPage(box.pageId);
      if (!entry) return;
      let nodeEl = null;
      if (state.renderHandle && typeof state.renderHandle.nodeElement === "function") {
        try { nodeEl = state.renderHandle.nodeElement(info.node.id); } catch (err) { nodeEl = null; }
      }
      const node = info.node;
      const font = (node.style && node.style.font) || {};
      const wrap = el("div", {
        class: "fmde-textedit",
        style: {
          left: box.x + "pt",
          top: box.y + "pt",
          width: Math.max(20, box.w) + "pt",
          minHeight: Math.max(10, box.h) + "pt",
          transform: box.rotation ? "rotate(" + box.rotation + "deg)" : ""
        }
      });
      const editable = el("div", { class: "fmde-textedit-area", contenteditable: "true", spellcheck: "false" });
      editable.style.fontFamily = font.family ? "'" + font.family + "', sans-serif" : "";
      editable.style.fontSize = (font.size_pt || state.doc.settings.base_font_pt || 11) + "pt";
      editable.style.fontWeight = font.weight ? String(font.weight) : "";
      editable.style.color = font.color || "";
      editable.style.lineHeight = String((node.props && node.props.line_height) || 1.4);
      if (node.props && node.props.letter_spacing) editable.style.letterSpacing = node.props.letter_spacing + "pt";
      editable.innerHTML = blocksToHtml((node.props && node.props.blocks) || []);
      wrap.appendChild(editable);

      let bar = null;
      if (can("text_style")) {
        bar = el("div", { class: "fmde-textbar" });
        const mkFmt = function (icon, title, command) {
          const btn = iconBtn(icon, title, function () {
            document.execCommand(command, false, null);
            editable.focus();
          });
          btn.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
          return btn;
        };
        bar.appendChild(mkFmt("bold", "Bold", "bold"));
        bar.appendChild(mkFmt("italic", "Italic", "italic"));
        bar.appendChild(mkFmt("underline", "Underline", "underline"));
        const done = el("button", { type: "button", class: "fmde-btn fmde-textbar-done", text: "Done" });
        done.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        done.addEventListener("click", function () { commitTextEdit(); });
        bar.appendChild(done);
        wrap.appendChild(bar);
      }

      if (nodeEl) nodeEl.style.visibility = "hidden";
      entry.overlay.appendChild(wrap);
      const editFontSize = num(font.size_pt, state.doc.settings.base_font_pt || 11);
      state.textEditing = { nodeId: node.id, wrap: wrap, editable: editable, nodeEl: nodeEl, originalBlocks: M.deepClone((node.props && node.props.blocks) || []), originalFontSize: editFontSize, fontSize: editFontSize };
      editable.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(editable);
        const sel = root.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) { /* selection best-effort */ }
      editable.addEventListener("blur", function () {
        // Give toolbar pointerdown (which prevents default) a beat; if focus
        // truly left the editing surface, commit.
        setTimeout(function () {
          if (state.textEditing && state.textEditing.editable === editable && document.activeElement !== editable) {
            commitTextEdit();
          }
        }, 120);
      });
      drawSelection();
    }

    function defaultShapeTextColor(node) {
      const existing = node && node.props && node.props.text_style && node.props.text_style.color;
      if (existing) return String(existing);
      const fill = node && node.style && node.style.fill;
      let raw = fill && typeof fill === "object" ? (fill.overlay_color || fill.color || fill.fallback_color) : fill;
      let parsed = parseCssColor(raw);
      if (!parsed && raw && typeof document !== "undefined" && (dom.root || document.body)) {
        const probe = document.createElement("span");
        probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;background:" + String(raw);
        (dom.root || document.body).appendChild(probe);
        parsed = parseCssColor(getComputedStyle(probe).backgroundColor);
        probe.remove();
      }
      if (!parsed) parsed = parseCssColor("#ffffff");
      const black = parseCssColor("#111827");
      const white = parseCssColor("#ffffff");
      return contrastRatio(parsed, black) >= contrastRatio(parsed, white) ? black.css : white.css;
    }

    function startShapeTextEdit(nodeId, initialText) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info || info.node.type !== "shape") return;
      if (lockBlocked(info.node, "content")) { flashReason("locked:content"); return; }
      if (state.textEditing) commitTextEdit();
      const box = overlayBox(info.node.id);
      const entry = box && entryForPage(box.pageId);
      if (!box || !entry) return;
      const node = info.node;
      const props = node.props || {};
      const textStyle = props.text_style || {};
      const color = defaultShapeTextColor(node);
      let nodeEl = null;
      if (state.renderHandle && typeof state.renderHandle.nodeElement === "function") {
        try { nodeEl = state.renderHandle.nodeElement(node.id); } catch (err) { nodeEl = null; }
      }
      const liveLabel = nodeEl && nodeEl.querySelector ? nodeEl.querySelector(".fmdoc-shape-label") : null;
      const originalLabelVisibility = liveLabel ? liveLabel.style.visibility : "";
      if (liveLabel) liveLabel.style.visibility = "hidden";
      const wrap = el("div", {
        class: "fmde-textedit fmde-shape-textedit",
        style: {
          left: box.x + "pt", top: box.y + "pt", width: Math.max(20, box.w) + "pt",
          height: Math.max(12, box.h) + "pt", transform: box.rotation ? "rotate(" + box.rotation + "deg)" : ""
        }
      });
      const editable = el("div", { class: "fmde-textedit-area", contenteditable: "true", spellcheck: "false" });
      editable.style.display = "flex";
      editable.style.alignItems = props.text_valign === "top" ? "flex-start" : props.text_valign === "bottom" ? "flex-end" : "center";
      editable.style.justifyContent = props.text_align === "left" ? "flex-start" : props.text_align === "right" ? "flex-end" : "center";
      editable.style.textAlign = props.text_align || "center";
      editable.style.padding = "6pt";
      editable.style.background = "rgba(255,255,255,.08)";
      editable.style.color = color;
      editable.style.fontFamily = textStyle.family || "";
      editable.style.fontSize = (num(textStyle.size_pt, state.doc.settings.base_font_pt || 11)) + "pt";
      editable.style.fontWeight = String(textStyle.weight || 500);
      editable.textContent = initialText !== undefined ? String(initialText) : String(props.text || "");
      editable.addEventListener("input", function () {
        if (liveLabel) liveLabel.textContent = editable.textContent || "";
      });
      wrap.appendChild(editable);

      const bar = el("div", { class: "fmde-textbar" });
      const colorInput = el("input", { type: "color", class: "fmde-color-swatch", title: (globalThis.PlatformLanguage?.text("doc-editor","m_99fb946f648fa8","Text color") ?? "Text color"), value: /^#[0-9a-f]{6}$/i.test(color) ? color : "#111827" });
      colorInput.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      colorInput.addEventListener("input", function () { editable.style.color = colorInput.value; if (liveLabel) liveLabel.style.color = colorInput.value; });
      bar.appendChild(colorInput);
      const done = el("button", { type: "button", class: "fmde-btn fmde-textbar-done", text: "Done" });
      done.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
      done.addEventListener("click", function () { commitTextEdit(); });
      bar.appendChild(done);
      wrap.appendChild(bar);
      entry.overlay.appendChild(wrap);
      state.textEditing = {
        kind: "shape", nodeId: node.id, wrap: wrap, editable: editable,
        originalText: String(props.text || ""), originalColor: color, colorInput: colorInput,
        originalFontSize: num(textStyle.size_pt, state.doc.settings.base_font_pt || 11),
        fontSize: num(textStyle.size_pt, state.doc.settings.base_font_pt || 11),
        liveLabel: liveLabel, originalLabelVisibility: originalLabelVisibility
      };
      editable.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(editable);
        if (initialText !== undefined) range.collapse(false);
        const selection = root.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (err) { /* best effort */ }
      drawSelection();
    }

    function commitTextEdit(cancel) {
      const editSession = state.textEditing;
      if (!editSession) return;
      state.textEditing = null;
      if (editSession.kind === "shape") {
        const text = cancel ? editSession.originalText : editSession.editable.textContent;
        const color = cancel ? editSession.originalColor : editSession.editable.style.color || editSession.originalColor;
        editSession.wrap.remove();
        if (editSession.liveLabel) {
          editSession.liveLabel.textContent = cancel ? editSession.originalText : text;
          editSession.liveLabel.style.color = cancel ? editSession.originalColor : color;
          editSession.liveLabel.style.fontSize = (cancel ? editSession.originalFontSize : editSession.fontSize) + "pt";
          editSession.liveLabel.style.visibility = editSession.originalLabelVisibility;
        }
        if (!cancel && (text !== editSession.originalText || color !== editSession.originalColor || editSession.fontSize !== editSession.originalFontSize)) {
          const commands = [
            { type: "node.set", node_id: editSession.nodeId, prop: "props.text", value: text },
            { type: "node.set", node_id: editSession.nodeId, prop: "props.text_style.color", value: color }
          ];
          if (editSession.fontSize !== editSession.originalFontSize) commands.push({ type: "node.set", node_id: editSession.nodeId, prop: "props.text_style.size_pt", value: editSession.fontSize });
          runCommands(commands, "shape-text");
        } else renderCanvas();
        return;
      }
      const blocks = cancel ? null : htmlToBlocks(editSession.editable, editSession.originalBlocks);
      editSession.wrap.remove();
      if (editSession.nodeEl) editSession.nodeEl.style.visibility = "";
      const fontSizeChanged = !cancel && editSession.fontSize !== editSession.originalFontSize;
      if (!cancel && (JSON.stringify(blocks) !== JSON.stringify(editSession.originalBlocks) || fontSizeChanged)) {
        const commands = [{ type: "text.edit", node_id: editSession.nodeId, blocks: blocks }];
        if (fontSizeChanged) commands.push({ type: "node.set", node_id: editSession.nodeId, prop: "style.font.size_pt", value: editSession.fontSize });
        runCommands(commands, "text");
      } else {
        renderCanvas();
      }
    }

    // ---------------------------------------------------------------------------
    // Doc mode — the word-processor projection (contract §9).
    //
    // EDITING MODEL: the logical block list lives on the SOURCE text nodes of
    // the document; the renderer paginates/splits them across chained frames
    // (split parts share data-node-id, blocks share data-block-id). Doc mode
    // sets contenteditable on the rendered chain text elements so the REAL
    // browser caret edits the rendered DOM, captures input events, and on
    // idle (~150ms) / blur / Enter / before any other command SERIALIZES the
    // touched nodes back to block lists (head+tail parts recombined by block
    // id) and commits them as text.edit commands through the normal bus. The
    // canvas then fully re-renders (repaginates) and the caret is restored
    // from { chain_id, node_id, block_id, char_offset-across-the-whole-block }.
    // Structural keys are intercepted: Enter -> text.split_block, Backspace at
    // block start -> text.merge_blocks (or a cross-node merge batch).
    // ---------------------------------------------------------------------------

    const docProjection = (function () {
      const P = {
        dirty: new Set(),   // raw source node ids with uncommitted DOM edits
        tableDirty: new Set(), // table node ids with uncommitted cell edits
        tableCaretAfter: null, // { node_id, row, col, offset } to restore post-render
        footnoteDirty: false,  // strip text edited since last commit
        footnoteCaretAfter: null, // { id, offset } to restore post-render
        caretAfter: null,   // caret to restore after the next settled render
        lastCaret: null,    // durable caret target while toolbar/page chrome has focus
        committing: false,
        timer: null
      };

      function tableCellFrom(target) {
        const cell = target && target.closest ? target.closest("td[data-cell], th[data-cell]") : null;
        if (!cell) return null;
        const tableEl = cell.closest('[data-node-type="table"][data-node-id]');
        if (!tableEl) return null;
        const coords = String(cell.getAttribute("data-cell")).split(":");
        return { cell: cell, tableEl: tableEl, nodeId: rawNodeId(tableEl.getAttribute("data-node-id") || ""), row: Number(coords[0]), col: Number(coords[1]) };
      }

      function isActive() {
        return state.mode === "doc" && !state.destroyed;
      }

      function cssq(value) {
        return String(value).replace(/"/g, '\\"');
      }

      function editableFrom(target) {
        return target && target.closest ? target.closest(".fmde-docedit") : null;
      }

      /** Elements that are NOT part of a block's run text: anchored nodes
       *  (inline widgets, floats) and anything explicitly non-editable. */
      function docSkipEl(node) {
        return !!(node && node.nodeType === 1 && node.hasAttribute && (
          node.hasAttribute("data-fmdoc-indent") ||
          node.hasAttribute("data-fmdoc-inline") ||
          node.hasAttribute("data-fmdoc-float") ||
          node.hasAttribute("data-node-id") ||
          node.getAttribute("contenteditable") === "false"
        ));
      }

      /** All rendered parts of a source node, in page order (split parts of a
       *  chain block land in successive frames/pages and share the node id). */
      function partsFor(nodeId) {
        const parts = [];
        for (const pageEl of pageElements()) {
          for (const match of Array.prototype.slice.call(pageEl.querySelectorAll('[data-node-id="' + cssq(nodeId) + '"]'))) {
            if (match.hasAttribute("data-chrome") || match.closest("[data-chrome]")) continue;
            parts.push(match);
          }
        }
        return parts;
      }

      function textLengthOf(node) {
        if (node.nodeType === 3) return (node.nodeValue || "").length;
        if (node.nodeType !== 1 || docSkipEl(node)) return 0;
        let total = 0;
        for (let child = node.firstChild; child; child = child.nextSibling) total += textLengthOf(child);
        return total;
      }

      function textOffsetWithin(blockEl, container, offset) {
        let total = 0;
        let found = false;
        (function walk(node) {
          if (found) return;
          if (node === container) {
            if (node.nodeType === 3) total += offset;
            else {
              let i = 0;
              for (let child = node.firstChild; child && i < offset; child = child.nextSibling, i += 1) total += textLengthOf(child);
            }
            found = true;
            return;
          }
          if (node.nodeType === 3) {
            total += (node.nodeValue || "").length;
            return;
          }
          if (node.nodeType !== 1 || (node !== blockEl && docSkipEl(node))) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            walk(child);
            if (found) return;
          }
        })(blockEl);
        return found ? total : 0;
      }

      function normalizeRuns(runs) {
        const merged = [];
        for (const run of runs) {
          const prev = merged[merged.length - 1];
          if (prev && sameRunStyle(prev, run)) prev.text += run.text;
          else merged.push(run);
        }
        const cleaned = merged.filter(function (run) { return run.text !== ""; });
        return cleaned.length ? cleaned : [{ text: "" }];
      }

      /**
       * Rebuild a source node's logical block list from its rendered parts.
       * Split parts (same data-block-id across parts) are recombined; block
       * metadata (type/align/style_ref/level) is preserved from the source by
       * block id (the browser never changes those); unknown DIVs (paste) get
       * fresh ids as paragraphs.
       */
      function parseBlocksFromParts(nodeId) {
        const info = state.nodeIndex.get(nodeId);
        const srcBlocks = (info && info.node.props && info.node.props.blocks) || [];
        const srcById = {};
        for (const block of srcBlocks) srcById[String(block.id)] = block;
        const out = [];
        const seenIds = new Set();
        for (const part of partsFor(nodeId)) {
          for (const blockEl of Array.prototype.slice.call(part.children)) {
            if (!blockEl.classList || !blockEl.classList.contains("fmdoc-block")) continue;
            const runs = [];
            collectRuns(blockEl, {}, runs, docSkipEl);
            const cleaned = runs.filter(function (run) { return run.text !== ""; });
            const domId = blockEl.getAttribute("data-block-id") || "";
            const projectedIndent = blockEl.hasAttribute("data-fmdoc-indent-projected")
              ? Array.prototype.slice.call(blockEl.querySelectorAll(":scope > [data-fmdoc-indent]")).filter(function (marker) {
                return String(marker.textContent || "").indexOf("\t") !== -1;
              }).length
              : null;
            const last = out[out.length - 1];
            if (domId && last && last.id === domId) {
              // Continuation (tail) of a line-split block: rejoin run streams.
              last.runs = normalizeRuns(last.runs.concat(cleaned));
              // Removing a selected marker from any rendered continuation
              // outdents the whole logical block.
              if (projectedIndent !== null) {
                const nextIndent = Math.min(Number(last.indent) || 0, projectedIndent);
                if (nextIndent) last.indent = nextIndent;
                else delete last.indent;
              }
              continue;
            }
            let id = domId;
            if (!id || seenIds.has(id)) id = M.generateId("blk");
            seenIds.add(id);
            const src = srcById[domId] || null;
            const typeMatch = /fmdoc-block--([a-z_]+)/.exec(blockEl.className || "");
            const block = {
              id: id,
              type: (src && src.type) || (typeMatch ? typeMatch[1] : "paragraph"),
              runs: cleaned.length ? normalizeRuns(cleaned) : [{ text: "" }]
            };
            if (src && src.align) block.align = src.align;
            const styleRef = blockEl.getAttribute("data-style-ref") || (src && src.style_ref) || null;
            if (styleRef) block.style_ref = styleRef;
            if (block.type === "heading") {
              const domLevel = Number(blockEl.getAttribute("data-level"));
              block.level = (src && src.level) || (Number.isFinite(domLevel) && domLevel > 0 ? domLevel : 1);
            }
            const indent = projectedIndent !== null ? projectedIndent : Number(src && src.indent) || 0;
            if (indent) block.indent = indent;
            if (src && src.line_height) block.line_height = src.line_height;
            if (src && src.list_style) block.list_style = src.list_style;
            if (src && src.space_before_pt !== undefined) block.space_before_pt = src.space_before_pt;
            if (src && src.space_after_pt !== undefined) block.space_after_pt = src.space_after_pt;
            if (src && src.direction) block.direction = src.direction;
            if (src && src.border) block.border = src.border;
            if (src && src.shading) block.shading = src.shading;
            if (src && src.list_restart) block.list_restart = src.list_restart;
            if (src && src.list_continue) block.list_continue = src.list_continue;
            if (src && src.first_line_indent_pt !== undefined) block.first_line_indent_pt = src.first_line_indent_pt;
            out.push(block);
          }
        }
        if (!out.length) out.push({ id: M.generateId("blk"), type: "paragraph", runs: [{ text: "" }] });
        return out;
      }

      function blockRunsLength(block) {
        let total = 0;
        for (const run of block.runs || []) total += String(run.text || "").length;
        return total;
      }

      function logicalBlockLength(nodeId, blockId) {
        let total = 0;
        for (const part of partsFor(nodeId)) {
          for (const blockEl of Array.prototype.slice.call(part.children)) {
            if (blockEl.getAttribute && blockEl.getAttribute("data-block-id") === blockId) total += textLengthOf(blockEl);
          }
        }
        return total;
      }

      /** Caret as { chain_id, node_id, block_id, offset } — offset counts
       *  characters across the WHOLE logical block (head+tail parts). */
      function serializeCaret() {
        const sel = root && root.getSelection ? root.getSelection() : null;
        if (!sel || !sel.rangeCount) return null;
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        const elx = container.nodeType === 1 ? container : container.parentElement;
        const part = editableFrom(elx);
        if (!part) return null;
        const nodeId = rawNodeId(part.getAttribute("data-node-id") || "");
        let blockEl = elx && elx.closest ? elx.closest(".fmdoc-block") : null;
        if (!blockEl) blockEl = part.querySelector(".fmdoc-block");
        if (!blockEl || !nodeId) return null;
        const blockId = blockEl.getAttribute("data-block-id") || "";
        let offset = blockEl.contains(container) ? textOffsetWithin(blockEl, container, range.startOffset) : 0;
        for (const p of partsFor(nodeId)) {
          if (p.contains(blockEl)) break;
          for (const b of Array.prototype.slice.call(p.children)) {
            if (b.getAttribute && b.getAttribute("data-block-id") === blockId) offset += textLengthOf(b);
          }
        }
        const chainFrame = part.closest("[data-chain]");
        const caret = {
          chain_id: chainFrame ? chainFrame.getAttribute("data-chain") : null,
          node_id: nodeId,
          block_id: blockId,
          offset: offset
        };
        P.lastCaret = caret;
        return caret;
      }

      function placeCaret(part, blockEl, offset) {
        let target = null;
        let local = 0;
        let rest = Math.max(0, offset);
        (function walk(node) {
          if (target) return;
          if (node.nodeType === 3) {
            const len = (node.nodeValue || "").length;
            if (rest <= len) {
              target = node;
              local = rest;
            } else rest -= len;
            return;
          }
          if (node.nodeType !== 1 || (node !== blockEl && docSkipEl(node))) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            walk(child);
            if (target) return;
          }
        })(blockEl);
        try {
          if (part && part.focus) part.focus({ preventScroll: true });
          const range = document.createRange();
          if (target) range.setStart(target, local);
          else {
            range.selectNodeContents(blockEl);
            range.collapse(true);
          }
          range.collapse(true);
          const sel = root.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          serializeCaret();
          applyTypingFormat(part);
          if (blockEl.scrollIntoView) { allowExplicitCanvasScroll(); blockEl.scrollIntoView({ block: "nearest" }); }
          return true;
        } catch (err) {
          return false;
        }
      }

      /** Restore a serialized caret against the freshly re-rendered (and
       *  possibly re-split) DOM: walk the node's parts, consuming the logical
       *  offset through same-block-id portions. */
      function restoreCaret(caret) {
        if (!caret || !caret.node_id) return false;
        const parts = partsFor(caret.node_id);
        let remaining = Math.max(0, Number(caret.offset) || 0);
        for (const part of parts) {
          for (const blockEl of Array.prototype.slice.call(part.children)) {
            if (!blockEl.getAttribute || blockEl.getAttribute("data-block-id") !== caret.block_id) continue;
            const len = textLengthOf(blockEl);
            if (remaining > len) {
              remaining -= len;
              continue;
            }
            return placeCaret(part, blockEl, remaining);
          }
        }
        if (parts.length) {
          const firstBlock = parts[0].querySelector(".fmdoc-block");
          if (firstBlock) return placeCaret(parts[0], firstBlock, 0);
        }
        return false;
      }
      function restoreLastCaret(passive) {
        const restored = restoreCaret(P.lastCaret);
        if (passive && restored) dom.root.classList.add("fmde-caret-passive");
        return restored;
      }

      /** Locate a character offset inside one rendered block element. */
      function positionAt(blockEl, offset) {
        let target = null;
        let local = 0;
        let rest = Math.max(0, offset);
        (function walk(node) {
          if (target) return;
          if (node.nodeType === 3) {
            const len = (node.nodeValue || "").length;
            if (rest <= len) { target = node; local = rest; } else rest -= len;
            return;
          }
          if (node.nodeType !== 1 || (node !== blockEl && docSkipEl(node))) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            walk(child);
            if (target) return;
          }
        })(blockEl);
        return target ? { node: target, offset: local } : null;
      }

      /** DOM Range over a logical [offset, offset+length) span of a block —
       *  spans page-split parts of the same node (find highlights, collab
       *  cursors). Returns null when the block isn't rendered. */
      function domRangeFor(nodeId, blockId, offset, length) {
        let start = null;
        let end = null;
        let remainingStart = Math.max(0, Number(offset) || 0);
        let remainingEnd = remainingStart + Math.max(0, Number(length) || 0);
        for (const part of partsFor(nodeId)) {
          for (const blockEl of Array.prototype.slice.call(part.children)) {
            if (!blockEl.getAttribute || blockEl.getAttribute("data-block-id") !== blockId) continue;
            const len = textLengthOf(blockEl);
            if (!start) {
              if (remainingStart <= len) start = positionAt(blockEl, remainingStart);
              else remainingStart -= len;
            }
            if (!end) {
              if (remainingEnd <= len) end = positionAt(blockEl, remainingEnd);
              else remainingEnd -= len;
            }
            if (start && end) break;
          }
          if (start && end) break;
        }
        if (!start || !end) return null;
        try {
          const range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          return range;
        } catch (err) {
          return null;
        }
      }

      /** Paragraph indentation is structural in the saved FMDoc model, but it
       *  should behave like the tabs that created it while editing. Project
       *  one literal tab per level into the contenteditable DOM. A compensating
       *  negative margin preserves the renderer's established 18pt layout;
       *  the parser skips the marker text and derives block.indent from the
       *  markers that survive an edit. */
      function projectIndentMarkers(part, sourceNode) {
        const byId = {};
        for (const block of (sourceNode && sourceNode.props && sourceNode.props.blocks) || []) {
          if (block && block.id) byId[String(block.id)] = block;
        }
        for (const blockEl of Array.prototype.slice.call(part.children || [])) {
          if (!blockEl.classList || !blockEl.classList.contains("fmdoc-block")) continue;
          for (const old of Array.prototype.slice.call(blockEl.querySelectorAll(":scope > [data-fmdoc-indent]"))) old.remove();
          blockEl.setAttribute("data-fmdoc-indent-projected", "true");
          const source = byId[blockEl.getAttribute("data-block-id") || ""];
          const level = clamp(Number(source && source.indent) || 0, 0, 8);
          if (!level) continue;
          const firstContent = blockEl.firstChild;
          for (let i = 0; i < level; i += 1) {
            const marker = document.createElement("span");
            marker.className = "fmdoc-indent-marker";
            marker.setAttribute("data-fmdoc-indent", "true");
            marker.setAttribute("aria-label", (globalThis.PlatformLanguage?.text("doc-editor","m_ac9481dbcc4f80","Tab") ?? "Tab"));
            marker.textContent = "\t";
            if (i === 0) marker.style.marginLeft = String(-level * 18) + "pt";
            blockEl.insertBefore(marker, firstContent);
          }
        }
      }

      /** After a settled render: make chain text editable + restore the caret. */
      function setup() {
        if (!isActive()) return;
        for (const pageEl of pageElements()) {
          for (const frameEl of Array.prototype.slice.call(pageEl.querySelectorAll("[data-chain]"))) {
            if (frameEl.hasAttribute("data-chrome")) continue;
            if (frameEl.hasAttribute("data-fmde-doc-placeholder")) {
              if (!frameEl.dataset.fmdePlaceholderFocus) {
                frameEl.dataset.fmdePlaceholderFocus = "true";
                frameEl.addEventListener("pointerdown", function (ev) {
                  if (ev.target.closest && ev.target.closest("[data-fmdoc-interactive]")) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  materializePlaceholder(
                    frameEl.getAttribute("data-fmde-placeholder-page-id") || pageEl.getAttribute("data-page-id"),
                    frameEl.getAttribute("data-page-region") || "body"
                  );
                });
              }
              continue;
            }
            for (const child of Array.prototype.slice.call(frameEl.children)) {
              if (!child.getAttribute || !child.hasAttribute("data-fmdoc-flow")) continue;
              if (child.getAttribute("data-node-type") !== "text") continue;
              const info = state.nodeIndex.get(rawNodeId(child.getAttribute("data-node-id") || ""));
              if (!info || lockBlocked(info.node, "content")) continue;
              child.setAttribute("contenteditable", "true");
              child.setAttribute("spellcheck", state.spellcheck ? "true" : "false");
              child.classList.add("fmde-docedit");
              projectIndentMarkers(child, info.node);
              // Anchored objects inside the run stream are atomic.
              for (const atom of Array.prototype.slice.call(child.querySelectorAll("[data-fmdoc-inline], [data-fmdoc-float], [data-node-id]"))) {
                atom.setAttribute("contenteditable", "false");
              }
            }
            // Clicking anywhere in a page region focuses its text stream,
            // matching the large invisible typing areas in word processors.
            if (!frameEl.dataset.fmdeRegionFocus) {
              frameEl.dataset.fmdeRegionFocus = "true";
              frameEl.addEventListener("pointerdown", function (ev) {
                if (editableFrom(ev.target)) return;
                // Table cells (and other interactive embeds) own their clicks.
                if (ev.target.closest && ev.target.closest('td[data-cell], th[data-cell], .fmde-table-chip, [data-node-type="image"], [data-fmdoc-interactive]')) return;
                const editable = frameEl.querySelector(".fmde-docedit");
                const block = editable && editable.querySelector(".fmdoc-block:last-child");
                if (!editable || !block) return;
                ev.preventDefault();
                editable.focus();
                placeCaret(editable, block, textLengthOf(block));
              });
            }
          }
        }
        // Header/footer VARIANT regions (different first page / odd & even):
        // static frames, not chained — make their text editable the same way.
        for (const frameEl of Array.prototype.slice.call(dom.stage.querySelectorAll('[data-page-region$="_first"], [data-page-region$="_even"]'))) {
          if (frameEl.hasAttribute("data-chrome")) continue;
          for (const child of Array.prototype.slice.call(frameEl.querySelectorAll('[data-node-type="text"][data-node-id]'))) {
            const info = state.nodeIndex.get(rawNodeId(child.getAttribute("data-node-id") || ""));
            if (!info || lockBlocked(info.node, "content")) continue;
            child.setAttribute("contenteditable", "true");
            child.setAttribute("spellcheck", state.spellcheck ? "true" : "false");
            child.classList.add("fmde-docedit");
            projectIndentMarkers(child, info.node);
          }
        }
        // Table cells: plain-text cells become directly editable (Docs parity).
        for (const tableEl of Array.prototype.slice.call(dom.stage.querySelectorAll('[data-node-type="table"][data-node-id]'))) {
          const info = state.nodeIndex.get(rawNodeId(tableEl.getAttribute("data-node-id") || ""));
          if (!info || lockBlocked(info.node, "content")) continue;
          for (const cellEl of Array.prototype.slice.call(tableEl.querySelectorAll("td[data-cell], th[data-cell]"))) {
            if (cellEl.querySelector(".fmdoc-block")) continue; // block-structured cells stay read-only in v1
            cellEl.setAttribute("contenteditable", "true");
            cellEl.setAttribute("spellcheck", state.spellcheck ? "true" : "false");
            cellEl.classList.add("fmde-cell-edit");
          }
        }
        // Footnote strips: editable text + editor-only delete buttons.
        for (const noteText of Array.prototype.slice.call(dom.stage.querySelectorAll(".fmdoc-footnote-text[data-footnote-id]"))) {
          noteText.setAttribute("contenteditable", "true");
          noteText.setAttribute("spellcheck", state.spellcheck ? "true" : "false");
        }
        for (const row of Array.prototype.slice.call(dom.stage.querySelectorAll(".fmdoc-footnote"))) {
          if (row.querySelector(".fmde-footnote-del")) continue;
          const del = el("button", { type: "button", class: "fmde-footnote-del", title: (globalThis.PlatformLanguage?.text("doc-editor","m_efdce507b17787","Delete footnote") ?? "Delete footnote"), text: "×" });
          del.addEventListener("pointerdown", function (ev) { ev.preventDefault(); ev.stopPropagation(); });
          del.addEventListener("click", (function (footnoteId) {
            return function () {
              const notes = M.deepClone(M.getPath(state.doc, "metadata.footnotes") || []).filter(function (n) { return n.id !== footnoteId; });
              runCommands([{ type: "doc.set", prop: "metadata.footnotes", value: notes }], "footnote:remove");
            };
          })(row.getAttribute("data-footnote-id")));
          row.appendChild(del);
        }
        if (P.footnoteCaretAfter) {
          const target = P.footnoteCaretAfter;
          P.footnoteCaretAfter = null;
          const noteText = dom.stage.querySelector('.fmdoc-footnote-text[data-footnote-id="' + cssq(target.id) + '"]');
          if (noteText) {
            noteText.focus({ preventScroll: true });
            try {
              const textNode = noteText.firstChild && noteText.firstChild.nodeType === 3 ? noteText.firstChild : null;
              const range = document.createRange();
              if (textNode) { range.setStart(textNode, Math.min(target.offset || 0, (textNode.nodeValue || "").length)); range.collapse(true); }
              else { range.selectNodeContents(noteText); range.collapse(false); }
              const sel = root.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } catch (err) { /* focus only */ }
          }
        }
        if (P.tableCaretAfter) {
          const target = P.tableCaretAfter;
          P.tableCaretAfter = null;
          const tableEl = dom.stage.querySelector('[data-node-id="' + cssq(target.node_id) + '"][data-node-type="table"], [data-node-id="' + cssq(target.node_id) + '::part0"][data-node-type="table"]');
          const cellEl = tableEl && tableEl.querySelector('[data-cell="' + target.row + ":" + target.col + '"]');
          if (cellEl) {
            cellEl.focus({ preventScroll: true });
            try {
              const textNode = cellEl.firstChild && cellEl.firstChild.nodeType === 3 ? cellEl.firstChild : null;
              const range = document.createRange();
              if (textNode) range.setStart(textNode, Math.min(target.offset || 0, (textNode.nodeValue || "").length));
              else { range.selectNodeContents(cellEl); range.collapse(false); }
              range.collapse(true);
              const sel = root.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } catch (err) { /* keep focus only */ }
          }
        }
        if (P.caretAfter) {
          const caret = P.caretAfter;
          P.caretAfter = null;
          restoreCaret(caret);
        }
      }

      function scheduleCommit() {
        if (P.timer) clearTimeout(P.timer);
        P.timer = setTimeout(function () {
          P.timer = null;
          commitNow("idle");
        }, DOC_COMMIT_MS);
      }

      /**
       * Serialize every dirty node from the DOM and push text.edit commands
       * (plus any extraCommands) through the bus as ONE history entry.
       * caretOverride: explicit caret to restore after re-render (pass null to
       * skip); undefined = capture the live caret.
       */
      function commitNow(reason, extraCommands, caretOverride) {
        if (P.timer) {
          clearTimeout(P.timer);
          P.timer = null;
        }
        if (P.committing) return null;
        if (!isActive()) {
          P.dirty.clear();
          return null;
        }
        const hasExtra = Array.isArray(extraCommands) && extraCommands.length > 0;
        if (!P.dirty.size && !P.tableDirty.size && !P.footnoteDirty && !hasExtra) return null;
        const caret = caretOverride !== undefined ? caretOverride : serializeCaret();
        const commands = [];
        for (const nodeId of Array.from(P.dirty)) {
          const info = state.nodeIndex.get(nodeId);
          if (!info || info.node.type !== "text") continue;
          const blocks = parseBlocksFromParts(nodeId);
          const prev = (info.node.props && info.node.props.blocks) || [];
          if (JSON.stringify(blocks) !== JSON.stringify(prev)) {
            commands.push({ type: "text.edit", node_id: nodeId, blocks: blocks });
          }
        }
        P.dirty.clear();
        // Table cell edits: read every rendered plain cell back into props.rows.
        for (const nodeId of Array.from(P.tableDirty)) {
          const info = state.nodeIndex.get(nodeId);
          if (!info || info.node.type !== "table") continue;
          const tableEl = dom.stage.querySelector('[data-node-id="' + cssq(nodeId) + '"][data-node-type="table"], [data-node-id="' + cssq(nodeId) + '::part0"][data-node-type="table"]');
          if (!tableEl) continue;
          const rows = M.deepClone((info.node.props && info.node.props.rows) || []);
          let changed = false;
          for (const cellEl of Array.prototype.slice.call(tableEl.querySelectorAll(".fmde-cell-edit"))) {
            const coords = String(cellEl.getAttribute("data-cell")).split(":");
            const row = rows[Number(coords[0])];
            const cell = row && row.cells && row.cells[Number(coords[1])];
            if (!cell || typeof cell !== "object" || Array.isArray(cell.blocks)) continue;
            const text = String(cellEl.innerText || "").replace(/ /g, " ").replace(/\n+$/, "");
            if (String(cell.text || "") !== text) { cell.text = text; changed = true; }
          }
          if (changed) commands.push({ type: "node.set", node_id: nodeId, prop: "props.rows", value: rows });
        }
        P.tableDirty.clear();
        if (P.footnoteDirty) {
          P.footnoteDirty = false;
          const notes = M.deepClone(M.getPath(state.doc, "metadata.footnotes") || []);
          let changed = false;
          for (const noteText of Array.prototype.slice.call(dom.stage.querySelectorAll('.fmdoc-footnote-text[data-footnote-id][contenteditable="true"]'))) {
            const note = notes.find(function (n) { return n.id === noteText.getAttribute("data-footnote-id"); });
            if (!note) continue;
            const text = String(noteText.innerText || "").replace(/ /g, " ").replace(/\n+$/, "");
            if (String(note.text || "") !== text) { note.text = text; changed = true; }
          }
          if (changed) commands.push({ type: "doc.set", prop: "metadata.footnotes", value: notes });
        }
        if (hasExtra) for (const cmd of extraCommands) commands.push(cmd);
        if (!commands.length) return null;
        P.caretAfter = caret;
        P.committing = true;
        try {
          return runCommands(commands, "doc:" + (reason || "edit"));
        } finally {
          P.committing = false;
        }
      }

      // ---- event handlers (delegated from dom.stage) --------------------------

      function onInput(ev) {
        if (!isActive()) return;
        const noteText = ev.target && ev.target.closest ? ev.target.closest(".fmdoc-footnote-text[data-footnote-id]") : null;
        if (noteText) {
          P.footnoteDirty = true;
          const sel = root.getSelection ? root.getSelection() : null;
          const offset = sel && sel.rangeCount && noteText.contains(sel.anchorNode) ? sel.anchorOffset : 0;
          P.footnoteCaretAfter = { id: noteText.getAttribute("data-footnote-id"), offset: offset };
          scheduleCommit();
          return;
        }
        const cellHit = tableCellFrom(ev.target);
        if (cellHit && cellHit.nodeId) {
          P.tableDirty.add(cellHit.nodeId);
          const sel = root.getSelection ? root.getSelection() : null;
          const offset = sel && sel.rangeCount && cellHit.cell.contains(sel.anchorNode) ? sel.anchorOffset : 0;
          P.tableCaretAfter = { node_id: cellHit.nodeId, row: cellHit.row, col: cellHit.col, offset: offset };
          scheduleCommit();
          return;
        }
        const part = editableFrom(ev.target);
        if (!part) return;
        const nodeId = rawNodeId(part.getAttribute("data-node-id") || "");
        if (!nodeId) return;
        normalizePendingFontSize(part);
        P.dirty.add(nodeId);
        // Idle commits are fine while text remains inside its current chain
        // frame. Crossing the frame's actual bottom must repaginate now;
        // otherwise continuous typing can visibly run through the footer
        // until the user pauses long enough for the debounce to fire.
        if (chainFrameOverflows(part)) commitNow("frame-overflow");
        else scheduleCommit();
      }

      function chainFrameOverflows(part) {
        const frame = part && part.closest ? part.closest("[data-chain]") : null;
        if (!frame) return false;
        if (frame.scrollHeight > frame.clientHeight + 1) return true;
        try {
          const rect = frame.getBoundingClientRect();
          const styles = root.getComputedStyle ? root.getComputedStyle(frame) : null;
          const padBottom = styles ? parseFloat(styles.paddingBottom) || 0 : 0;
          const limit = rect.top + frame.clientTop + frame.clientHeight - padBottom;
          return part.getBoundingClientRect().bottom > limit + 0.5;
        } catch (error) {
          return false;
        }
      }

      function onFocusOut(ev) {
        if (!isActive() || P.committing) return;
        const fromCell = ev.target && ev.target.closest && ev.target.closest(".fmde-cell-edit");
        if (!editableFrom(ev.target) && !fromCell) return;
        setTimeout(function () {
          if (!isActive() || P.committing) return;
          const active = document.activeElement;
          if (active && (editableFrom(active) || (active.closest && active.closest(".fmde-cell-edit")))) return;
          commitNow("blur");
        }, 0);
      }

      /** Text of the block BEFORE the caret container+offset (atoms skipped). */
      function blockTextBefore(blockEl, container, offset) {
        let out = "";
        let done = false;
        (function walk(node) {
          if (done) return;
          if (node === container) { out += (node.nodeValue || "").slice(0, offset); done = true; return; }
          if (node.nodeType === 3) { out += node.nodeValue || ""; return; }
          if (node.nodeType !== 1 || (node !== blockEl && docSkipEl(node))) return;
          for (let child = node.firstChild; child && !done; child = child.nextSibling) walk(child);
        })(blockEl);
        return out;
      }

      /** Docs-style autocorrect, applied when a separator is typed: smart
       *  quotes, "1. "/"- " auto-lists, URL auto-link, dictionary typo fixes,
       *  sentence auto-capitalization. All edits are DOM-level; the normal
       *  commit re-parse picks them up. */
      function handleAutocorrectInput(part, ev) {
        const sel = root.getSelection ? root.getSelection() : null;
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
        const container = sel.anchorNode;
        if (!container || container.nodeType !== 3 || !container.parentElement) return;
        const blockEl = container.parentElement.closest(".fmdoc-block");
        if (!blockEl) return;
        const offset = sel.anchorOffset;
        const beforeText = blockTextBefore(blockEl, container, offset);
        if (ev.data === '"' || ev.data === "'") {
          ev.preventDefault();
          const open = !beforeText || /[\s(\[{‘“]$/.test(beforeText);
          document.execCommand("insertText", false, ev.data === '"' ? (open ? "“" : "”") : (open ? "‘" : "’"));
          return;
        }
        const nodeId = rawNodeId(part.getAttribute("data-node-id") || "");
        // Typing-format execCommands fragment typed text into single-character
        // nodes, so a word usually spans SEVERAL text nodes: walk back from
        // the caret across the block's text nodes to select it.
        const selectWordBefore = function (length) {
          const texts = [];
          (function walk(node) {
            if (node.nodeType === 3) { texts.push(node); return; }
            if (node.nodeType !== 1 || (node !== blockEl && docSkipEl(node))) return;
            for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
          })(blockEl);
          let index = texts.indexOf(container);
          if (index === -1) return false;
          let remaining = length;
          let nodeOffset = offset;
          while (remaining > 0) {
            if (nodeOffset >= remaining) { nodeOffset -= remaining; remaining = 0; break; }
            remaining -= nodeOffset;
            index -= 1;
            if (index < 0) return false;
            nodeOffset = (texts[index].nodeValue || "").length;
          }
          try {
            const range = document.createRange();
            range.setStart(texts[index], nodeOffset);
            range.setEnd(container, offset);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
          } catch (err) { return false; }
        };
        // "1. " / "- " at the start of a paragraph becomes a list. All
        // corrections CANCEL the pending input and replay through execCommand
        // (mutating the DOM mid-beforeinput races the browser's own edit).
        const rawWord = (/(\S+)$/.exec(beforeText) || [])[1] || "";
        if (ev.data === " " && rawWord && beforeText === rawWord && ["-", "*", "1.", "1)"].indexOf(rawWord) !== -1) {
          ev.preventDefault();
          if (selectWordBefore(rawWord.length)) document.execCommand("delete");
          const style = rawWord === "-" || rawWord === "*" ? "bullet" : "number";
          mutateCoveredBlocks("auto-list", function (block) {
            if (block.type !== "list_item") { block.type = "list_item"; block.list_style = style; }
          });
          return;
        }
        // URL auto-link.
        if (/^(https?:\/\/|www\.)[^\s]{3,}$/i.test(rawWord) && !container.parentElement.closest("a")) {
          if (selectWordBefore(rawWord.length)) {
            ev.preventDefault();
            document.execCommand("createLink", false, /^www\./i.test(rawWord) ? "https://" + rawWord : rawWord);
            const live = root.getSelection();
            if (live && live.rangeCount) { const range = live.getRangeAt(0); range.collapse(false); live.removeAllRanges(); live.addRange(range); }
            document.execCommand("insertText", false, ev.data);
          }
          return;
        }
        // Dictionary typo fix + sentence auto-capitalization (letters only —
        // never touch tokens with digits/punctuation).
        const word = (/([A-Za-z']+)$/.exec(beforeText) || [])[1] || "";
        if (!word) return;
        const lib = state.languageReady ? languageLib() : null;
        let result = word;
        if (lib) { try { result = lib.autocorrect(word) || word; } catch (err) { result = word; } }
        const beforeWord = beforeText.slice(0, beforeText.length - word.length);
        const sentenceStart = beforeWord === "" || /[.!?]\s+$/.test(beforeWord);
        if (sentenceStart && /^[a-z]/.test(result)) result = result.charAt(0).toUpperCase() + result.slice(1);
        if (result !== word && selectWordBefore(word.length)) {
          ev.preventDefault();
          document.execCommand("insertText", false, result + ev.data);
        }
      }

      function onBeforeInput(ev) {
        if (!isActive()) return;
        const part = editableFrom(ev.target);
        if (!part) return;
        clearDocObjectSelectionForText();
        const type = ev.inputType || "";
        if (type === "insertText" && ev.data && state.autocorrect !== false && (ev.data === '"' || ev.data === "'" || ev.data === " " || /^[.,!?;:]$/.test(ev.data))) {
          handleAutocorrectInput(part, ev);
          if (ev.defaultPrevented) return;
        }
        if (type === "historyUndo") {
          ev.preventDefault();
          performUndo();
          return;
        }
        if (type === "historyRedo") {
          ev.preventDefault();
          performRedo();
          return;
        }
        if (type === "insertParagraph") {
          ev.preventDefault();
          handleEnter();
          return;
        }
        if (type.indexOf("insert") === 0) applyTypingFormat(part);
        if (type === "deleteContentBackward" || type === "deleteContentForward") {
          const sel = root.getSelection ? root.getSelection() : null;
          if (!sel || !sel.rangeCount || !sel.isCollapsed) return; // range deletes: browser + commit parser
          const caret = serializeCaret();
          if (!caret) return;
          if (type === "deleteContentBackward" && caret.offset === 0) {
            ev.preventDefault();
            handleBackspaceAtStart(caret);
          } else if (type === "deleteContentForward" && caret.offset === 0 && removeIndentAtCaret(caret)) {
            // Treat paragraph indentation like a structural character at the
            // start of the block. Delete removes that prefix before it removes
            // the first text character.
            ev.preventDefault();
          } else if (type === "deleteContentForward" && caret.offset >= logicalBlockLength(caret.node_id, caret.block_id)) {
            ev.preventDefault();
            handleDeleteAtEnd(caret);
          }
        }
      }

      // ---- structural edits ----------------------------------------------------

      function blockIndexIn(blocks, blockId) {
        for (let i = 0; i < blocks.length; i += 1) if (blocks[i].id === blockId) return i;
        return -1;
      }

      function handleEnter() {
        const caret = serializeCaret();
        if (!caret) return;
        const blocks = parseBlocksFromParts(caret.node_id);
        const idx = blockIndexIn(blocks, caret.block_id);
        if (idx === -1) return;
        const block = blocks[idx];
        if (block.type === "list_item" && blockRunsLength(block) === 0) {
          block.type = "paragraph";
          delete block.list_style;
          delete block.indent;
          P.dirty.delete(caret.node_id);
          P.caretAfter = { chain_id: caret.chain_id, node_id: caret.node_id, block_id: block.id, offset: 0 };
          runCommands([{ type: "text.edit", node_id: caret.node_id, blocks: blocks }], "doc:exit-list");
          return;
        }
        const newId = M.generateId("blk");
        P.dirty.add(caret.node_id);
        commitNow("enter",
          [{ type: "text.split_block", node_id: caret.node_id, block_index: idx, offset: caret.offset, new_block_id: newId }],
          { chain_id: caret.chain_id, node_id: caret.node_id, block_id: newId, offset: 0 });
      }

      function removeIndentLevel(nodeId, blocks, blockIndex, caretAfter) {
        const block = blocks && blocks[blockIndex];
        const indent = Number(block && block.indent) || 0;
        if (!block || indent <= 0) return false;
        if (indent > 1) block.indent = indent - 1;
        else delete block.indent;
        P.dirty.delete(nodeId);
        commitNow("outdent", [{ type: "text.edit", node_id: nodeId, blocks: blocks }], caretAfter);
        return true;
      }

      function removeIndentAtCaret(caret) {
        const blocks = parseBlocksFromParts(caret.node_id);
        const idx = blockIndexIn(blocks, caret.block_id);
        if (idx === -1) return false;
        return removeIndentLevel(caret.node_id, blocks, idx, caret);
      }

      function handleBackspaceAtStart(caret) {
        const blocks = parseBlocksFromParts(caret.node_id);
        const idx = blockIndexIn(blocks, caret.block_id);
        if (idx === -1) return;
        // An indent is a structural prefix. Backspace at the block start
        // removes one level before it considers merging with the prior block.
        if (removeIndentLevel(caret.node_id, blocks, idx, caret)) return;
        if (idx > 0) {
          const target = blocks[idx - 1];
          P.dirty.add(caret.node_id);
          commitNow("merge",
            [{ type: "text.merge_blocks", node_id: caret.node_id, block_index: idx }],
            { chain_id: caret.chain_id, node_id: caret.node_id, block_id: target.id, offset: blockRunsLength(target) });
          return;
        }
        // An explicit page break behaves like the structural character that
        // created it: Backspace at the first position after the break removes
        // the boundary and rejoins the two text streams in one undoable edit.
        if (removePageBreakBefore(caret)) return;
        // Hybrid documents can also contain authored pages created in Visual
        // mode. Such a page has no preceding page_break to remove. If its
        // entire source page is empty, Backspace from its first Doc position
        // removes that authored page with the same word-processor behavior.
        if (removeBlankAuthoredPageAtCaret(caret)) return;
        // First block of the node: merge this node into the previous chain
        // text node (one atomic batch: rewrite previous + remove this node).
        const prevId = previousChainTextNode(caret.node_id, caret.chain_id);
        if (!prevId) return;
        const prevInfo = state.nodeIndex.get(prevId);
        if (!prevInfo || lockBlocked(prevInfo.node, "content")) return;
        mergeNodes(prevId, caret.node_id, caret.chain_id);
      }

      function handleDeleteAtEnd(caret) {
        const blocks = parseBlocksFromParts(caret.node_id);
        const idx = blockIndexIn(blocks, caret.block_id);
        if (idx === -1) return;
        if (idx < blocks.length - 1) {
          // Delete at the end of a block sits immediately before the next
          // block's indent prefix, so remove that before merging paragraphs.
          if (removeIndentLevel(caret.node_id, blocks, idx + 1, caret)) return;
          P.dirty.add(caret.node_id);
          commitNow("merge",
            [{ type: "text.merge_blocks", node_id: caret.node_id, block_index: idx + 1 }],
            { chain_id: caret.chain_id, node_id: caret.node_id, block_id: caret.block_id, offset: caret.offset });
          return;
        }
        const nextId = nextChainTextNode(caret.node_id, caret.chain_id);
        if (!nextId) return;
        const nextInfo = state.nodeIndex.get(nextId);
        if (!nextInfo || lockBlocked(nextInfo.node, "content")) return;
        const nextBlocks = parseBlocksFromParts(nextId);
        if (removeIndentLevel(nextId, nextBlocks, 0, caret)) return;
        mergeNodes(caret.node_id, nextId, caret.chain_id, caret);
      }

      /** Merge srcNode's blocks onto the end of destNode (first src block joins
       *  dest's last block), then remove srcNode — one history entry. */
      function mergeNodes(destId, srcId, chainId, caretOverride) {
        const destBlocks = parseBlocksFromParts(destId);
        const srcBlocks = parseBlocksFromParts(srcId);
        const lastDest = destBlocks[destBlocks.length - 1];
        const caretOffset = blockRunsLength(lastDest);
        const first = srcBlocks[0];
        lastDest.runs = normalizeRuns(
          (lastDest.runs || []).filter(function (run) { return run.text !== ""; })
            .concat((first.runs || []).filter(function (run) { return run.text !== ""; }))
        );
        for (let i = 1; i < srcBlocks.length; i += 1) destBlocks.push(srcBlocks[i]);
        P.dirty.delete(destId);
        P.dirty.delete(srcId);
        P.caretAfter = caretOverride || { chain_id: chainId, node_id: destId, block_id: lastDest.id, offset: caretOffset };
        P.committing = true;
        try {
          runCommands([
            { type: "text.edit", node_id: destId, blocks: destBlocks },
            { type: "node.remove", node_id: srcId }
          ], "doc:merge-nodes");
        } finally {
          P.committing = false;
        }
      }

      // ---- chain topology ------------------------------------------------------

      /** Distinct flow node ids of a chain, in visual (page/frame) order. */
      function chainNodeOrder(chainId) {
        const list = [];
        const seen = new Set();
        const selector = chainId ? '[data-chain="' + cssq(chainId) + '"]' : "[data-chain]";
        for (const pageEl of pageElements()) {
          for (const frameEl of Array.prototype.slice.call(pageEl.querySelectorAll(selector))) {
            if (frameEl.hasAttribute("data-chrome")) continue;
            for (const child of Array.prototype.slice.call(frameEl.children)) {
              if (!child.getAttribute || !child.hasAttribute("data-fmdoc-flow")) continue;
              const id = rawNodeId(child.getAttribute("data-node-id") || "");
              if (!id || seen.has(id)) continue;
              seen.add(id);
              list.push({ id: id, type: child.getAttribute("data-node-type") });
            }
          }
        }
        return list;
      }

      function previousChainTextNode(nodeId, chainId) {
        const list = chainNodeOrder(chainId);
        for (let i = 1; i < list.length; i += 1) {
          if (list[i].id === nodeId) return list[i - 1].type === "text" ? list[i - 1].id : null;
        }
        return null;
      }

      function nextChainTextNode(nodeId, chainId) {
        const list = chainNodeOrder(chainId);
        for (let i = 0; i < list.length - 1; i += 1) {
          if (list[i].id === nodeId) return list[i + 1].type === "text" ? list[i + 1].id : null;
        }
        return null;
      }

      function pageBreakBeforeTextNode(nodeId, chainId) {
        const list = chainNodeOrder(chainId);
        const pos = list.findIndex(function (item) { return item.id === nodeId; });
        if (pos < 1 || list[pos - 1].type !== "page_break") return null;
        const source = state.nodeIndex.get(nodeId);
        const boundary = state.nodeIndex.get(list[pos - 1].id);
        if (!source || !boundary || !source.parentId || source.parentId !== boundary.parentId) return null;
        if (boundary.index + 1 !== source.index) return null;
        let previous = null;
        if (pos >= 2 && list[pos - 2].type === "text") {
          const candidate = state.nodeIndex.get(list[pos - 2].id);
          if (candidate && candidate.parentId === source.parentId && candidate.index + 1 === boundary.index) previous = candidate;
        }
        return { previous: previous, boundary: boundary, source: source };
      }

      function removePageBreakBefore(caret) {
        const found = pageBreakBeforeTextNode(caret.node_id, caret.chain_id);
        if (!found || lockBlocked(found.source.node, "content")) return false;
        if (!found.previous) {
          P.dirty.delete(found.source.node.id);
          P.caretAfter = {
            chain_id: caret.chain_id,
            node_id: found.source.node.id,
            block_id: caret.block_id,
            offset: 0
          };
          P.committing = true;
          try {
            runCommands([
              { type: "node.remove", node_id: found.boundary.node.id }
            ], "doc:remove-page-break");
          } finally {
            P.committing = false;
          }
          return true;
        }
        if (lockBlocked(found.previous.node, "content")) return false;
        const destBlocks = parseBlocksFromParts(found.previous.node.id);
        const srcBlocks = parseBlocksFromParts(found.source.node.id);
        if (!destBlocks.length || !srcBlocks.length) return false;
        const target = destBlocks[destBlocks.length - 1];
        const caretOffset = blockRunsLength(target);
        const first = srcBlocks[0];
        target.runs = normalizeRuns(
          (target.runs || []).filter(function (run) { return String(run.text || "") !== ""; })
            .concat((first.runs || []).filter(function (run) { return String(run.text || "") !== ""; }))
        );
        for (let i = 1; i < srcBlocks.length; i += 1) destBlocks.push(srcBlocks[i]);
        P.dirty.delete(found.previous.node.id);
        P.dirty.delete(found.source.node.id);
        P.caretAfter = {
          chain_id: caret.chain_id,
          node_id: found.previous.node.id,
          block_id: target.id,
          offset: caretOffset
        };
        P.committing = true;
        try {
          runCommands([
            { type: "text.edit", node_id: found.previous.node.id, blocks: destBlocks },
            { type: "node.remove", node_id: found.boundary.node.id },
            { type: "node.remove", node_id: found.source.node.id }
          ], "doc:remove-page-break");
        } finally {
          P.committing = false;
        }
        return true;
      }

      function pageIsStructurallyBlank(page) {
        let blank = true;
        (function visit(nodes) {
          for (const node of nodes || []) {
            if (!blank || !node || node.visible === false) continue;
            if (node.type === "frame") {
              visit(node.children);
              continue;
            }
            if (node.type === "text") {
              const blocks = (node.props && node.props.blocks) || [];
              const content = blocks.map(function (block) {
                return (block.runs || []).map(function (run) { return String(run.text || ""); }).join("");
              }).join("");
              if (content.trim()) blank = false;
              continue;
            }
            // A boundary or non-text object is intentional page content even
            // when its rendered label/value happens to be empty.
            blank = false;
          }
        })(page && page.children);
        return blank;
      }

      function lastTextCaretOnPage(page) {
        let target = null;
        (function visit(nodes, chainId) {
          for (const node of nodes || []) {
            const nextChain = node && node.props && node.props.chain && node.props.chain.id
              ? node.props.chain.id
              : chainId;
            if (node && node.type === "text") {
              const blocks = (node.props && node.props.blocks) || [];
              const block = blocks[blocks.length - 1];
              if (block) target = {
                chain_id: nextChain || null,
                node_id: node.id,
                block_id: block.id,
                offset: blockRunsLength(block)
              };
            }
            visit(node && node.children, nextChain);
          }
        })(page && page.children, null);
        return target;
      }

      function removeBlankAuthoredPageAtCaret(caret) {
        const info = caret && state.nodeIndex.get(caret.node_id);
        const pages = state.doc.pages || [];
        const pageIndex = info ? pages.findIndex(function (page) { return page.id === info.pageId; }) : -1;
        if (pageIndex <= 0 || pages.length <= 1) return false;
        const page = pages[pageIndex];
        if (!pageIsStructurallyBlank(page)) return false;
        const previousCaret = lastTextCaretOnPage(pages[pageIndex - 1]);
        P.dirty.delete(caret.node_id);
        const result = commitNow("remove-blank-page", [
          { type: "page.remove", page_id: page.id }
        ], previousCaret || null);
        return !!(result && result.ok);
      }

      function firstChainFrame() {
        let found = null;
        M.walkNodes(state.doc, function (node) {
          if (node.type === "frame" && node.props && node.props.chain && node.props.chain.id) {
            found = node;
            return false;
          }
        });
        return found;
      }

      function currentChainId() {
        const caret = caretTarget();
        if (caret && caret.chain_id) return caret.chain_id;
        const chains = Object.keys(state.doc.chains || {});
        if (chains.length) return chains[0];
        const frame = firstChainFrame();
        return frame ? frame.props.chain.id : null;
      }

      // ---- selection-driven toolbar operations ---------------------------------

      function hintMsg(text) {
        dom.hint.textContent = text;
        dom.hint.classList.remove("warn");
        dom.hint.classList.add("show");
        clearTimeout(hintMsg._timer);
        hintMsg._timer = setTimeout(function () { dom.hint.classList.remove("show"); }, 1600);
      }

      /** Blocks intersecting the current selection: [{node_id, block_id}]. */
      function caretTarget() {
        return serializeCaret() || (P.lastCaret ? { ...P.lastCaret } : null);
      }

      /** Stable annotation target captured before toolbar focus moves the
       *  browser selection. A selected passage is retained as context while a
       *  collapsed caret anchors the thread to its current paragraph. */
      function annotationTarget() {
        const caret = caretTarget();
        if (!caret) return null;
        const sel = root.getSelection ? root.getSelection() : null;
        const quote = sel && sel.rangeCount && !sel.isCollapsed ? String(sel.toString() || "") : "";
        return {
          chain_id: caret.chain_id,
          node_id: caret.node_id,
          block_id: caret.block_id,
          offset: caret.offset,
          end_offset: caret.offset + quote.length,
          quote: quote
        };
      }

      function coveredBlockRefs() {
        const sel = root.getSelection ? root.getSelection() : null;
        const caret = caretTarget();
        const caretRef = caret && caret.node_id && caret.block_id ? [{ node_id: caret.node_id, block_id: caret.block_id }] : [];
        if (!sel || !sel.rangeCount || sel.isCollapsed) return caretRef;
        const range = sel.getRangeAt(0);
        const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const focusEl = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
        if (!editableFrom(anchorEl) || !editableFrom(focusEl)) return caretRef;
        const out = [];
        const seen = new Set();
        for (const pageEl of pageElements()) {
          for (const part of Array.prototype.slice.call(pageEl.querySelectorAll(".fmde-docedit"))) {
            for (const blockEl of Array.prototype.slice.call(part.children)) {
              if (!blockEl.classList || !blockEl.classList.contains("fmdoc-block")) continue;
              let hit = false;
              try {
                hit = range.intersectsNode(blockEl);
              } catch (err) {
                hit = false;
              }
              if (!hit) continue;
              const nodeId = rawNodeId(part.getAttribute("data-node-id") || "");
              const blockId = blockEl.getAttribute("data-block-id") || "";
              if (!nodeId || !blockId) continue;
              const key = nodeId + "::" + blockId;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push({ node_id: nodeId, block_id: blockId });
            }
          }
        }
        return out.length ? out : caretRef;
      }

      /** Style dropdown: text.set_style_ref for every covered block. */
      function applyStyleRef(ref) {
        const caret = caretTarget();
        const refs = coveredBlockRefs();
        if (!refs.length) {
          hintMsg("Click into the document text first");
          return;
        }
        const byNode = {};
        for (const entry of refs) (byNode[entry.node_id] = byNode[entry.node_id] || []).push(entry.block_id);
        const commands = [];
        for (const nodeId of Object.keys(byNode)) {
          if (!state.nodeIndex.has(nodeId)) continue;
          const blocks = parseBlocksFromParts(nodeId);
          P.dirty.add(nodeId); // uncommitted typing lands first as text.edit
          for (const blockId of byNode[nodeId]) {
            const idx = blockIndexIn(blocks, blockId);
            if (idx !== -1) commands.push({ type: "text.set_style_ref", node_id: nodeId, block_index: idx, ref: ref });
          }
        }
        if (commands.length) commitNow("style", commands, caret);
      }

      /** Block-level mutation (align, list toggle) over the covered blocks. */
      function mutateCoveredBlocks(label, fn) {
        const caret = caretTarget();
        const refs = coveredBlockRefs();
        if (!refs.length) {
          hintMsg("Click into the document text first");
          return;
        }
        const byNode = {};
        for (const entry of refs) (byNode[entry.node_id] = byNode[entry.node_id] || new Set()).add(entry.block_id);
        const commands = [];
        for (const nodeId of Object.keys(byNode)) {
          if (!state.nodeIndex.has(nodeId)) continue;
          const blocks = parseBlocksFromParts(nodeId);
          for (const block of blocks) {
            if (byNode[nodeId].has(block.id)) fn(block);
          }
          commands.push({ type: "text.edit", node_id: nodeId, blocks: blocks });
          P.dirty.delete(nodeId);
        }
        if (commands.length) commitNow(label, commands, caret);
      }

      /** Run-level toggles (bold/italic/underline) over the browser selection;
       *  the mutation is captured by the commit parser. */
      function rememberTypingFormat(command, value) {
        if (command === "fontName") state.typingFormat.family = canonicalFontFamily(value);
        else if (command === "fontSize") state.typingFormat.size_pt = clamp(Number(value) || 11, 6, 96);
        else if (command === "foreColor") state.typingFormat.color = String(value || "#202124");
        else if (command === "hiliteColor") state.typingFormat.background = String(value || "transparent");
        else if (["bold", "italic", "underline", "strikeThrough", "superscript", "subscript"].includes(command)) state.typingFormat[command] = !(state.typingFormat[command] === true);
      }

      function normalizePendingFontSize(part) {
        if (!part) return;
        for (const font of Array.from(part.querySelectorAll('font[size]'))) {
          if (state.typingFormat.size_pt) font.style.fontSize = String(state.typingFormat.size_pt) + "pt";
          font.removeAttribute("size");
        }
      }

      function applyTypingFormat(part) {
        if (!part) return;
        const f = state.typingFormat;
        try {
          if (f.family) document.execCommand("fontName", false, f.family);
          if (f.size_pt) document.execCommand("fontSize", false, "7");
          if (f.color) document.execCommand("foreColor", false, f.color);
          if (f.background) document.execCommand("hiliteColor", false, f.background);
          for (const command of ["bold", "italic", "underline", "strikeThrough", "superscript", "subscript"]) {
            if (f[command] !== null && !!document.queryCommandState(command) !== f[command]) document.execCommand(command, false, null);
          }
        } catch (err) { /* execCommand unavailable */ }
      }

      function format(command, value) {
        const toggle = ["bold", "italic", "underline", "strikeThrough", "superscript", "subscript"].includes(command);
        const sel = root.getSelection ? root.getSelection() : null;
        if (!sel || !sel.rangeCount) {
          rememberTypingFormat(command, value);
          hintMsg("Formatting set for new text");
          return;
        }
        const anchor = sel.anchorNode;
        const elx = anchor && anchor.nodeType === 1 ? anchor : anchor && anchor.parentElement;
        const part = editableFrom(elx);
        if (!part) {
          rememberTypingFormat(command, value);
          hintMsg("Formatting set for new text");
          return;
        }
        if (!toggle) rememberTypingFormat(command, value);
        try {
          document.execCommand(command, false, command === "fontSize" ? "7" : (value === undefined ? null : value));
          if (toggle) state.typingFormat[command] = !!document.queryCommandState(command);
          if (command === "fontSize" && value) normalizePendingFontSize(part);
        } catch (err) { /* execCommand unavailable */ }
        if (sel.isCollapsed) return;
        const nodeId = rawNodeId(part.getAttribute("data-node-id") || "");
        if (nodeId) {
          P.dirty.add(nodeId);
          scheduleCommit();
        }
      }

      /** Mirror the caret's actual formatting into state.typingFormat and the
       *  toolbar (Google-Docs behavior: the pending format follows the caret;
       *  explicit toolbar choices then override it until the caret moves). */
      function syncTypingFormatFromCaret() {
        const sel = root.getSelection ? root.getSelection() : null;
        if (!sel || !sel.rangeCount) return;
        const anchor = sel.anchorNode;
        let element = anchor && anchor.nodeType === 1 ? anchor : anchor && anchor.parentElement;
        if (!element || !editableFrom(element)) return;
        // Block elements carry paragraph defaults; descend to the run at the caret.
        if (element.classList && element.classList.contains("fmdoc-block")) {
          let child = element.childNodes[Math.min(sel.anchorOffset, Math.max(0, element.childNodes.length - 1))] || element.firstChild;
          while (child && child.nodeType === 1 && child.firstChild && !docSkipEl(child)) child = child.firstChild;
          const runEl = child && (child.nodeType === 3 ? child.parentElement : child);
          if (runEl && runEl.nodeType === 1 && !docSkipEl(runEl)) element = runEl;
        }
        const css = root.getComputedStyle ? root.getComputedStyle(element) : null;
        if (!css) return;
        const f = state.typingFormat;
        // Chromium can report the concrete @font-face name here (for example
        // `Montserrat-Regular`) even though the user chose the catalog family
        // `Montserrat`. Never let that implementation detail become the next
        // typing format or get persisted into a run.
        f.family = canonicalFontFamily(css.fontFamily);
        f.size_pt = roundPt((parseFloat(css.fontSize) || 14.67) * 72 / 96);
        f.color = css.color || "#202124";
        f.background = css.backgroundColor && css.backgroundColor !== "rgba(0, 0, 0, 0)" ? css.backgroundColor : "transparent";
        f.bold = parseInt(css.fontWeight, 10) >= 600;
        f.italic = css.fontStyle === "italic";
        const deco = String(css.textDecorationLine || css.textDecoration || "");
        f.underline = deco.indexOf("underline") !== -1;
        f.strikeThrough = deco.indexOf("line-through") !== -1;
        f.superscript = css.verticalAlign === "super";
        f.subscript = css.verticalAlign === "sub";
        updateDocToolbarFromCaret();
      }

      /** Rewrite the SELECTED text through fn (capitalization commands). The
       *  DOM is mutated in place and re-parsed by the normal commit pipeline,
       *  so run boundaries and formatting are untouched. */
      function transformSelectionText(fn) {
        const sel = root.getSelection ? root.getSelection() : null;
        if (!sel || !sel.rangeCount || sel.isCollapsed) { hintMsg("Select the text to change first"); return false; }
        const range = sel.getRangeAt(0);
        const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
        let node = walker.currentNode && walker.currentNode.nodeType === 3 ? walker.currentNode : walker.nextNode();
        const touched = new Set();
        while (node) {
          if (range.intersectsNode(node) && node.parentElement && !docSkipEl(node.parentElement)) {
            const part = editableFrom(node.parentElement);
            if (part) {
              const text = node.nodeValue || "";
              const from = node === range.startContainer ? range.startOffset : 0;
              const to = node === range.endContainer ? range.endOffset : text.length;
              if (to > from) {
                node.nodeValue = text.slice(0, from) + fn(text.slice(from, to)) + text.slice(to);
                touched.add(rawNodeId(part.getAttribute("data-node-id") || ""));
              }
            }
          }
          node = walker.nextNode();
        }
        if (!touched.size) return false;
        for (const id of touched) P.dirty.add(id);
        commitNow("transform-case");
        return true;
      }

      function captureFormatting() {
        const sel = root.getSelection ? root.getSelection() : null;
        const anchor = sel && sel.anchorNode;
        let element = anchor && anchor.nodeType === 1 ? anchor : anchor && anchor.parentElement;
        // A paragraph-level selection anchors on the block element whose
        // computed style is the paragraph default; sample the first real text
        // run inside the selection so run formatting (font/bold/color) copies.
        if (element && sel && sel.rangeCount && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
          let node = walker.currentNode && walker.currentNode.nodeType === 3 ? walker.currentNode : walker.nextNode();
          while (node) {
            if (range.intersectsNode(node) && String(node.nodeValue || "").trim() && node.parentElement && !docSkipEl(node.parentElement)) {
              element = node.parentElement;
              break;
            }
            node = walker.nextNode();
          }
        }
        if (!element || !editableFrom(element)) { hintMsg("Select formatted text first"); return null; }
        const css = root.getComputedStyle ? root.getComputedStyle(element) : null;
        if (!css) return null;
        return {
          family: canonicalFontFamily(css.fontFamily),
          size_pt: roundPt((parseFloat(css.fontSize) || 14.67) * 72 / 96),
          color: css.color || "",
          background: css.backgroundColor && css.backgroundColor !== "rgba(0, 0, 0, 0)" ? css.backgroundColor : "",
          bold: parseInt(css.fontWeight, 10) >= 600,
          italic: css.fontStyle === "italic",
          underline: String(css.textDecorationLine || css.textDecoration).indexOf("underline") !== -1
        };
      }

      function applyFormatting(formatting) {
        if (!formatting) return;
        if (formatting.family) format("fontName", formatting.family);
        if (formatting.size_pt) format("fontSize", formatting.size_pt);
        if (formatting.color) format("foreColor", formatting.color);
        if (formatting.background) format("hiliteColor", formatting.background);
        if (formatting.bold && !document.queryCommandState("bold")) format("bold");
        if (formatting.italic && !document.queryCommandState("italic")) format("italic");
        if (formatting.underline && !document.queryCommandState("underline")) format("underline");
      }

      /** Insert a flow-anchored node after the caret's block node (source
       *  position — the renderer repaginates it into place). */
      function insertFlowNode(node, caretOverride) {
        if (!isActive() || !node) return null;
        const caret = caretOverride !== undefined ? caretOverride : caretTarget();
        let parentId = null;
        let index = null;
        if (caret) {
          const info = state.nodeIndex.get(caret.node_id);
          if (info && info.parentId) {
            parentId = info.parentId;
            index = info.index + 1;
          }
        }
        if (!parentId) {
          const frame = firstChainFrame();
          if (!frame) {
            hintMsg("This document has no flow chain to insert into");
            return null;
          }
          parentId = frame.id;
          index = (frame.children || []).length;
        }
        return commitNow("insert", [{ type: "node.insert", node: node, parent_id: parentId, index: index }], caret || null);
      }

      function splitRunsAt(runs, offset) {
        const head = [];
        const tail = [];
        let seen = 0;
        for (const sourceRun of runs || []) {
          const run = M.deepClone(sourceRun);
          const text = String(run.text || "");
          if (seen + text.length <= offset) head.push(run);
          else if (seen >= offset) tail.push(run);
          else {
            const cut = offset - seen;
            const before = M.deepClone(run);
            const after = M.deepClone(run);
            before.text = text.slice(0, cut);
            after.text = text.slice(cut);
            head.push(before);
            tail.push(after);
          }
          seen += text.length;
        }
        return { head: normalizeRuns(head), tail: normalizeRuns(tail) };
      }

      function applySuggestion(suggestion, suggestions) {
        if (!suggestion) return null;
        const info = state.nodeIndex.get(String(suggestion.node_id || ""));
        if (!info || info.node.type !== "text" || lockBlocked(info.node, "content")) return null;
        const blocks = parseBlocksFromParts(info.node.id);
        const index = blockIndexIn(blocks, suggestion.block_id);
        if (index < 0) return null;
        const block = blocks[index];
        const length = blockRunsLength(block);
        const start = clamp(Number(suggestion.offset) || 0, 0, length);
        const end = clamp(Number(suggestion.end_offset) || start, start, length);
        const currentText = (block.runs || []).map(function (run) { return String(run.text || ""); }).join("");
        if (suggestion.before_text !== undefined && currentText.slice(start, end) !== String(suggestion.before_text)) {
          hintMsg("This suggestion conflicts with newer edits");
          return null;
        }
        const before = splitRunsAt(block.runs, start);
        const removed = splitRunsAt(before.tail, end - start);
        const replacement = String(suggestion.replacement || "");
        const styleSource = removed.head.find(function (run) { return String(run.text || ""); }) || before.head[before.head.length - 1] || removed.tail[0] || { text: "" };
        const replacementRun = M.deepClone(styleSource);
        replacementRun.text = replacement;
        block.runs = normalizeRuns(before.head.concat(replacement ? [replacementRun] : []).concat(removed.tail));
        P.dirty.delete(info.node.id);
        return commitNow("suggestion:accept", [
          { type: "text.edit", node_id: info.node.id, blocks: blocks },
          { type: "doc.set", prop: "metadata.suggestions", value: suggestions }
        ], { chain_id: suggestion.chain_id, node_id: info.node.id, block_id: block.id, offset: start + replacement.length });
      }

      /** Insert an explicit page boundary at the logical caret. The containing
       * text node is split so the tail becomes the first editable text box on
       * the next page; all three changes share one undo entry. */
      function insertPageBreak(caretOverride) {
        if (!isActive()) return null;
        const caret = caretOverride !== undefined ? caretOverride : caretTarget();
        if (!caret || !caret.node_id || !caret.block_id) {
          hintMsg("Click into the document text first");
          return null;
        }
        const info = state.nodeIndex.get(caret.node_id);
        if (!info || info.node.type !== "text" || !info.parentId || lockBlocked(info.node, "content")) return null;
        const blocks = parseBlocksFromParts(info.node.id);
        const blockIndex = blockIndexIn(blocks, caret.block_id);
        if (blockIndex < 0) return null;
        const current = blocks[blockIndex];
        const offset = clamp(Math.max(0, Number(caret.offset) || 0), 0, blockRunsLength(current));
        const split = splitRunsAt(current.runs, offset);
        const headBlock = M.deepClone(current);
        headBlock.runs = split.head;
        const tailBlock = M.deepClone(current);
        tailBlock.id = M.generateId("blk");
        tailBlock.runs = split.tail;
        const headBlocks = blocks.slice(0, blockIndex).concat([headBlock]);
        const tailBlocks = [tailBlock].concat(blocks.slice(blockIndex + 1));
        const tailNode = M.deepClone(info.node);
        tailNode.id = M.generateId("nd");
        tailNode.name = info.node.name ? info.node.name + " continuation" : "Text continuation";
        if (!tailNode.props) tailNode.props = {};
        tailNode.props.blocks = tailBlocks;
        const boundary = M.createNode("page_break", {
          name: "Page break",
          anchor: "flow",
          frame: { x: 0, y: 0, w: 0, h: 0, z: 0 }
        });
        P.dirty.delete(info.node.id);
        return commitNow("page-break", [
          { type: "text.edit", node_id: info.node.id, blocks: headBlocks },
          { type: "node.insert", node: boundary, parent_id: info.parentId, index: info.index + 1 },
          { type: "node.insert", node: tailNode, parent_id: info.parentId, index: info.index + 2 }
        ], {
          chain_id: caret.chain_id,
          node_id: tailNode.id,
          block_id: tailBlock.id,
          offset: 0
        });
      }

      function materializePlaceholder(pageId, region) {
        if (!isActive()) return null;
        const found = M.findPage(state.doc, pageId);
        const page = found && found.page;
        if (!page || ["header", "body", "footer"].indexOf(region) === -1) return null;
        if (findPageRegionFrame(page, region)) return null;
        const pageIndex = (state.doc.pages || []).findIndex(function (entry) { return entry.id === page.id; });
        const sourceFrame = region === "body" ? null : sourcePageRegionFrame(state.doc, region, page.id);
        const frame = createDocRegionFrame(state.doc, page, Math.max(0, pageIndex), region, false, sourceFrame);
        let textNode = null;
        (function firstText(nodes) {
          for (const node of nodes || []) {
            if (textNode) return;
            if (node && node.type === "text") { textNode = node; return; }
            firstText(node && node.children);
          }
        })(frame.children);
        if (!textNode) { textNode = createDocRegionText(region.charAt(0).toUpperCase() + region.slice(1)); frame.children.push(textNode); }
        const block = textNode.props.blocks[0];
        const chainId = frame.props.chain.id;
        const commands = [];
        if (!M.getPath(state.doc, "chains." + chainId)) {
          commands.push({ type: "doc.set", prop: "chains." + chainId, value: docRegionChainDefinition(state.doc, region) });
        }
        commands.push({
          type: "node.insert",
          node: frame,
          page_id: page.id,
          index: docRegionInsertIndex(page, region)
        });
        state.currentPageId = page.id;
        return commitNow("doc-placeholder", commands, {
          chain_id: chainId,
          node_id: textNode.id,
          block_id: block.id,
          offset: 0
        });
      }

      function appendPageBreak() {
        if (!isActive()) return null;
        const pages = state.doc.pages || [];
        const page = pages[pages.length - 1];
        if (!page) return null;
        let frame = findPageRegionFrame(page, "body");
        const chainId = frame && frame.props && frame.props.chain && frame.props.chain.id
          ? frame.props.chain.id
          : docPageRegionChainId(page.id, "body");
        const commands = [];
        if (!M.getPath(state.doc, "chains." + chainId)) {
          commands.push({ type: "doc.set", prop: "chains." + chainId, value: docRegionChainDefinition(state.doc, "body") });
        }
        const boundary = M.createNode("page_break", {
          name: "Page break",
          anchor: "flow",
          frame: { x: 0, y: 0, w: 0, h: 0, z: 0 }
        });
        const tail = createDocRegionText("Body continuation");
        const tailBlock = tail.props.blocks[0];
        if (!frame) {
          frame = createDocRegionFrame(state.doc, page, Math.max(0, pages.length - 1), "body", false);
          frame.children.push(boundary, tail);
          commands.push({
            type: "node.insert",
            node: frame,
            page_id: page.id,
            index: docRegionInsertIndex(page, "body")
          });
        } else {
          const end = (frame.children || []).length;
          commands.push({ type: "node.insert", node: boundary, parent_id: frame.id, index: end });
          commands.push({ type: "node.insert", node: tail, parent_id: frame.id, index: end + 1 });
        }
        state.currentPageId = page.id;
        return commitNow("append-page-break", commands, {
          chain_id: chainId,
          node_id: tail.id,
          block_id: tailBlock.id,
          offset: 0
        });
      }

      /** Insert dictated plain text at a serialized logical caret and commit it
       *  through the same text.edit command used by keyboard input. */
      function insertText(text, caretOverride) {
        if (!isActive()) return null;
        let value = String(text || "").trim();
        const caret = caretOverride || caretTarget();
        if (!value || !caret || !caret.node_id) return null;
        const info = state.nodeIndex.get(caret.node_id);
        if (!info || info.node.type !== "text" || lockBlocked(info.node, "content")) return null;
        const blocks = M.deepClone((info.node.props && info.node.props.blocks) || []);
        let blockIndex = blocks.findIndex(function (block) { return block.id === caret.block_id; });
        if (blockIndex < 0) blockIndex = Math.max(0, blocks.length - 1);
        if (!blocks.length) {
          blocks.push({ id: M.generateId("blk"), type: "paragraph", runs: [{ text: "" }] });
          blockIndex = 0;
        }
        const block = blocks[blockIndex];
        if (!Array.isArray(block.runs) || !block.runs.length) block.runs = [{ text: "" }];
        const blockText = block.runs.map(function (run) { return String(run.text || ""); }).join("");
        const logicalOffset = clamp(Math.max(0, Number(caret.offset) || 0), 0, blockText.length);
        value = spaceDictation(value, blockText.slice(0, logicalOffset), blockText.slice(logicalOffset));
        let remaining = Math.max(0, Number(caret.offset) || 0);
        let inserted = false;
        for (let i = 0; i < block.runs.length; i += 1) {
          const run = block.runs[i];
          const current = String(run.text || "");
          if (remaining <= current.length) {
            run.text = current.slice(0, remaining) + value + current.slice(remaining);
            inserted = true;
            break;
          }
          remaining -= current.length;
        }
        if (!inserted) block.runs[block.runs.length - 1].text = String(block.runs[block.runs.length - 1].text || "") + value;
        const nextCaret = {
          chain_id: caret.chain_id || null,
          node_id: info.node.id,
          block_id: block.id,
          offset: Math.max(0, Number(caret.offset) || 0) + value.length
        };
        return commitNow("dictation", [{ type: "text.edit", node_id: info.node.id, blocks: blocks }], nextCaret);
      }

      /** Before undo/redo: aim the caret at the current block's start (the
       *  exact offset may not survive the inverse ops — block start is the
       *  documented behavior). */
      function caretToAffectedBlock() {
        if (!isActive()) return;
        const caret = caretTarget();
        if (caret) P.caretAfter = { chain_id: caret.chain_id, node_id: caret.node_id, block_id: caret.block_id, offset: 0 };
      }

      function reset() {
        if (P.timer) {
          clearTimeout(P.timer);
          P.timer = null;
        }
        P.dirty.clear();
        P.caretAfter = null;
        P.lastCaret = null;
      }

      return {
        setup: setup,
        reset: reset,
        commitNow: commitNow,
        onBeforeInput: onBeforeInput,
        onInput: onInput,
        onFocusOut: onFocusOut,
        format: format,
        captureFormatting: captureFormatting,
        applyFormatting: applyFormatting,
        applyStyleRef: applyStyleRef,
        mutateCoveredBlocks: mutateCoveredBlocks,
        insertFlowNode: insertFlowNode,
        insertPageBreak: insertPageBreak,
        appendPageBreak: appendPageBreak,
        insertText: insertText,
        currentChainId: currentChainId,
        serializeCaret: serializeCaret,
        caretTarget: caretTarget,
        annotationTarget: annotationTarget,
        syncTypingFormatFromCaret: syncTypingFormatFromCaret,
        transformSelectionText: transformSelectionText,
        domRangeFor: domRangeFor,
        tableCellFrom: tableCellFrom,
        applySuggestion: applySuggestion,
        restoreLastCaret: restoreLastCaret,
        caretToAffectedBlock: caretToAffectedBlock,
        hint: hintMsg,
        pendingDirty: function () { return P.dirty.size > 0; }
      };
    })();

    function spaceDictation(value, before, after) {
      let text = String(value || "").trim();
      if (before && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(text)) text = " " + text;
      if (after && !/^\s/.test(after) && /[\p{L}\p{N}]$/u.test(text)) text += " ";
      return text;
    }

    function dictationTarget() {
      if (state.mode === "doc") {
        const caret = docProjection.caretTarget();
        if (caret) return caret;
      }
      const nodeId = state.textEditing?.nodeId || (state.selection.length === 1 ? state.selection[0] : "");
      const info = nodeId ? state.nodeIndex.get(rawNodeId(nodeId)) : null;
      if (!info || info.node.type !== "text" || lockBlocked(info.node, "content")) return null;
      const blocks = (info.node.props && info.node.props.blocks) || [];
      const block = blocks[blocks.length - 1] || null;
      let offset = 0;
      if (block) for (const run of block.runs || []) offset += String(run.text || "").length;
      return { chain_id: null, node_id: info.node.id, block_id: block && block.id, offset: offset };
    }

    function insertDictationOutsideDocMode(text, target) {
      let value = String(text || "").trim();
      const info = target && state.nodeIndex.get(rawNodeId(target.node_id));
      if (!value || !info || info.node.type !== "text" || lockBlocked(info.node, "content")) return null;
      const blocks = M.deepClone((info.node.props && info.node.props.blocks) || []);
      if (!blocks.length) blocks.push({ id: M.generateId("blk"), type: "paragraph", runs: [{ text: "" }] });
      let block = blocks.find(function (item) { return item.id === target.block_id; }) || blocks[blocks.length - 1];
      if (!Array.isArray(block.runs) || !block.runs.length) block.runs = [{ text: "" }];
      const currentText = block.runs.map(function (run) { return String(run.text || ""); }).join("");
      value = spaceDictation(value, currentText, "");
      block.runs[block.runs.length - 1].text = String(block.runs[block.runs.length - 1].text || "") + value;
      return runCommands([{ type: "text.edit", node_id: info.node.id, blocks: blocks }], "dictation");
    }

    function startDictation() {
      if (state.dictating || typeof opts.onDictate !== "function") return;
      let target = dictationTarget();
      if (!target) {
        showStatus("Click in an editable text section first", true);
        return;
      }
      if (state.textEditing) {
        commitTextEdit();
        target = dictationTarget() || target;
      } else if (state.mode === "doc") {
        docProjection.commitNow("dictation-flush", null, target);
      }
      state.dictating = true;
      if (dom.btnDictate) {
        dom.btnDictate.disabled = true;
        dom.btnDictate.classList.add("active");
      }
      showStatus("Recording dictation…", false, 0);
      Promise.resolve(opts.onDictate({
        document: M.deepClone(state.doc),
        mode: state.mode,
        nodeId: target.node_id
      })).then(function (result) {
        const text = typeof result === "string" ? result : result && result.text;
        if (!String(text || "").trim()) throw new Error("No speech was detected.");
        const applied = state.mode === "doc"
          ? docProjection.insertText(text, target)
          : insertDictationOutsideDocMode(text, target);
        if (!applied || applied.ok === false) throw new Error("The selected section is no longer editable.");
        showStatus("Dictation inserted", false);
      }).catch(function (error) {
        const message = String(error && error.message || "Could not transcribe this recording.");
        if (!/cancel/i.test(message)) showStatus(message, true, 3200);
        else if (dom.hint) dom.hint.classList.remove("show", "warn");
      }).finally(function () {
        state.dictating = false;
        if (dom.btnDictate) {
          dom.btnDictate.disabled = false;
          dom.btnDictate.classList.remove("active");
        }
      });
    }

    // ---------------------------------------------------------------------------
    // Visual mode v2 — component definition editing + instance detach.
    //
    // "Edit component" (DEFAULT) opens the def in a floating card: the def is
    // instantiated with a sample input (first repeater row when one is bound
    // to it) and rendered on a mini canvas; field edits commit through
    // component.update_def so every instance updates on the next render.
    // "Detach instance" freezes the current resolved subtree onto the ref
    // (props.detached = true + children) — a fork that stops following the def.
    // ---------------------------------------------------------------------------

    let compCard = null;

    function mergedComponentDefs() {
      try {
        return M.mergedComponents(state.doc, (opts.catalog && opts.catalog.components) || {});
      } catch (err) {
        return M.deepClone(state.doc.components || {});
      }
    }

    function componentScope() {
      try {
        return M.buildScope(opts.resolveScope || {});
      } catch (err) {
        return { params: {} };
      }
    }

    /** Sample instantiation context: first row of a repeater bound to the def. */
    function componentSample(name, def) {
      let row = null;
      let as = "row";
      M.walkNodes(state.doc, function (node) {
        if (node.type === "repeater" && node.props && node.props.component === name && node.props.source) {
          try {
            const value = M.interpolate(String(node.props.source), componentScope());
            if (Array.isArray(value) && value.length) {
              row = value[0];
              as = node.props.as || "row";
              return false;
            }
          } catch (err) { /* sample is best-effort */ }
        }
      });
      const input = {};
      const scope = Object.assign({}, componentScope());
      if (row !== null) {
        input.__row = row;
        for (const key of Object.keys((def && def.params) || {})) {
          input[key] = row && row[key] !== undefined ? row[key] : row;
        }
        scope[as] = row;
        scope.index = 0;
      }
      return { input: input, scope: scope };
    }

    function collectDefFields(def) {
      const fields = [];
      (function walk(node, path) {
        if (!node || typeof node !== "object") return;
        if (node.type === "text" && node.props && Array.isArray(node.props.blocks)) {
          node.props.blocks.forEach(function (block, bi) {
            (block.runs || []).forEach(function (run, ri) {
              const isBind = run.bind !== undefined;
              fields.push({
                label: String(node.name || node.id || "text").slice(0, 18) + (isBind ? " (bind)" : ""),
                path: path + ".props.blocks." + bi + ".runs." + ri + (isBind ? ".bind" : ".text"),
                value: isBind ? run.bind : (run.text || ""),
                kind: "text"
              });
            });
          });
        }
        if ((node.type === "frame" || node.type === "shape") && node.style && node.style.fill && node.style.fill.color) {
          fields.push({
            label: String(node.name || node.type).slice(0, 14) + " fill",
            path: path + ".style.fill.color",
            value: node.style.fill.color,
            kind: "color"
          });
        }
        (node.children || []).forEach(function (child, index) { walk(child, path + ".children." + index); });
      })(def && def.root, "root");
      return fields;
    }

    function closeComponentCard() {
      if (!compCard) return;
      if (compCard.renderHandle && typeof compCard.renderHandle.destroy === "function") {
        try { compCard.renderHandle.destroy(); } catch (err) { /* gone */ }
      }
      compCard.el.remove();
      compCard = null;
    }

    function openComponentCard(name) {
      closeComponentCard();
      const defs = mergedComponentDefs();
      if (!name || !defs[name]) {
        flashReason("component_missing:" + name);
        return;
      }
      const preview = el("div", { class: "fmde-compcard-preview" });
      const body = el("div", { class: "fmde-compcard-body" });
      const head = el("div", { class: "fmde-compcard-head" },
        el("span", { class: "fmde-inspector-type", html: iconSvg("component") }),
        el("span", { text: name }),
        iconBtn("x", "Close", closeComponentCard, "fmde-btn-sm")
      );
      const card = el("div", { class: "fmde-compcard" }, head, preview, body);
      dom.canvas.appendChild(card);
      compCard = { name: name, el: card, preview: preview, body: body, renderHandle: null, lastDefJson: null };
      renderComponentCard();
    }

    function renderComponentCard() {
      if (!compCard) return;
      const name = compCard.name;
      const defs = mergedComponentDefs();
      const def = defs[name];
      if (!def) {
        closeComponentCard();
        return;
      }
      compCard.lastDefJson = JSON.stringify(def);

      // Mini canvas: isolated instantiation of the def (sample input).
      if (compCard.renderHandle && typeof compCard.renderHandle.destroy === "function") {
        try { compCard.renderHandle.destroy(); } catch (err) { /* gone */ }
        compCard.renderHandle = null;
      }
      compCard.preview.innerHTML = "";
      try {
        const sample = componentSample(name, def);
        const roots = M.instantiateComponent(def, sample.input, sample.scope, { components: defs }, "fmde_comppreview");
        const rootNode = roots && roots[0];
        if (rootNode) {
          rootNode.frame = Object.assign({}, rootNode.frame, { x: 0, y: 0, w: 320, h: "auto" });
          const viewDoc = {
            schema_version: 2,
            kind: "view",
            settings: M.deepClone(state.doc.settings || {}),
            styles: M.deepClone(state.doc.styles || {}),
            metadata: {},
            root: rootNode
          };
          compCard.renderHandle = renderer.render(compCard.preview, {
            document: viewDoc,
            theme: currentTheme(),
            themeContext: opts.themeContext || null,
            mode: "interactive",
            scale: 1
          });
        }
      } catch (err) {
        compCard.preview.textContent = "Preview unavailable: " + (err && err.message);
      }

      // Field editors → component.update_def (all instances update on commit).
      compCard.body.innerHTML = "";
      compCard.body.appendChild(el("div", { class: "fmde-compcard-note", text: "Edits apply to every instance of this component." }));
      const commitField = function (field) {
        return function (value) {
          const next = M.deepClone(mergedComponentDefs()[name] || def);
          M.setPath(next, field.path, value);
          runCommands([{ type: "component.update_def", name: name, def: next }], "component");
        };
      };
      for (const field of collectDefFields(def).slice(0, 24)) {
        const control = field.kind === "color"
          ? colorField(field.value, commitField(field))
          : textInputField(field.value, commitField(field));
        compCard.body.appendChild(fieldRow(field.label, control));
      }
      const advanced = sectionBox("Definition (advanced)");
      const area = el("textarea", { class: "fmde-input fmde-textarea", rows: "7" });
      area.value = JSON.stringify(def, null, 2);
      area.addEventListener("change", function () {
        try {
          const parsed = JSON.parse(area.value);
          area.classList.remove("invalid");
          runCommands([{ type: "component.update_def", name: name, def: parsed }], "component");
        } catch (err) {
          area.classList.add("invalid");
        }
      });
      area.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
      advanced.body.appendChild(area);
      compCard.body.appendChild(advanced.root);
    }

    /** Re-render the card only when the def actually changed (avoids nuking
     *  field focus on unrelated commands). */
    function refreshComponentCard() {
      if (!compCard) return;
      const def = mergedComponentDefs()[compCard.name];
      const json = def ? JSON.stringify(def) : "";
      if (json === compCard.lastDefJson) return;
      renderComponentCard();
    }

    function detachComponentInstance(nodeId) {
      const info = state.nodeIndex.get(nodeId);
      if (!info || info.node.type !== "component_ref") return;
      const name = info.node.props && info.node.props.component;
      const defs = mergedComponentDefs();
      const def = name ? defs[name] : null;
      if (!def) {
        flashReason("component_missing:" + name);
        return;
      }
      const scope = componentScope();
      const input = {};
      const rawInput = (info.node.props && info.node.props.input) || {};
      for (const key of Object.keys(rawInput)) {
        const raw = rawInput[key];
        input[key] = typeof raw === "string" && M.hasInterpolation(raw) ? M.interpolate(raw, scope) : raw;
      }
      if (info.node.props && info.node.props.variant) input.__variant = info.node.props.variant;
      let roots = [];
      try {
        roots = M.instantiateComponent(def, input, scope, { components: defs }, nodeId + "_fork") || [];
      } catch (err) {
        roots = [];
      }
      if (!roots.length) {
        flashReason("component_missing:" + name);
        return;
      }
      for (const inst of roots) {
        inst.frame = M.deepMerge(inst.frame || {}, { x: 0, y: 0 });
      }
      // frame.layout "flow" so the fork's content-sized root renders in flow
      // inside the ref frame instead of collapsing to a 0pt absolute box.
      const result = runCommands([
        { type: "component.detach", node_id: nodeId, children: roots },
        { type: "node.set", node_id: nodeId, prop: "frame.layout", value: "flow" }
      ], "detach");
      if (result.ok) renderInspector();
    }

    // ---- dropdown menus --------------------------------------------------------------------------

    let openMenu = null;
    let openMenuAnchor = null;
    let openMenus = [];
    function closeMenusFrom(depth) {
      while (openMenus.length > depth) openMenus.pop().remove();
      openMenu = openMenus[0] || null;
    }
    function closeMenu() {
      if (openMenus.length || openMenu) {
        closeMenusFrom(0);
        if (openMenu && openMenu.isConnected) openMenu.remove();
        openMenu = null;
        if (openMenuAnchor) openMenuAnchor.classList.remove("active");
        openMenuAnchor = null;
        document.removeEventListener("pointerdown", onMenuOutside, true);
      }
    }
    function onMenuOutside(ev) {
      if (openMenus.length && !openMenus.some(function (menu) { return menu.contains(ev.target); })) closeMenu();
    }
    function showMenu(anchor, items, options) {
      options = options || {};
      const depth = Number(options.depth) || 0;
      const point = options.point;
      const anchorRect = point
        ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
        : anchor.getBoundingClientRect();
      if (depth === 0) closeMenu(); else closeMenusFrom(depth);
      const menu = applyEditorBranding(el("div", { class: "fmde-menu" + (options.submenu ? " fmde-submenu" : "") + (options.className ? " " + options.className : "") }));
      if (options.before) menu.appendChild(options.before);
      for (const item of items) {
        if (item && typeof item.render === "function") {
          const custom = item.render(menu);
          if (custom) menu.appendChild(custom);
          continue;
        }
        if (item === "-") {
          menu.appendChild(el("div", { class: "fmde-menu-sep" }));
          continue;
        }
        if (item.heading) {
          menu.appendChild(el("div", { class: "fmde-menu-heading", text: item.heading }));
          continue;
        }
        const children = typeof item.children === "function" ? item.children() : item.children;
        const checked = typeof item.checked === "function" ? !!item.checked() : !!item.checked;
        const disabled = typeof item.disabled === "function" ? !!item.disabled() : !!item.disabled;
        const row = el("button", {
          type: "button",
          class: "fmde-menu-item" + (checked ? " checked" : "") + (disabled ? " disabled" : ""),
          html: (item.icon ? '<span class="fmde-menu-ic">' + iconSvg(item.icon) + "</span>" : "") + '<span class="fmde-menu-label">' + (item.labelHtml || esc(item.label)) + "</span>" + (item.shortcut ? '<span class="fmde-menu-shortcut">' + esc(item.shortcut) + "</span>" : "") + (checked ? '<span class="fmde-menu-check">' + iconSvg("check") + "</span>" : "") + (children && children.length ? '<span class="fmde-menu-arrow">›</span>' : "")
        });
        // Keep any live text selection (doc-mode style/format menus act on it).
        row.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        const openChildren = function () { if (children && children.length && !disabled) showMenu(row, children, { depth: depth + 1, submenu: true, className: item.submenuClass || "" }); };
        row.addEventListener("pointerenter", function () {
          if (children && children.length) openChildren();
          else closeMenusFrom(depth + 1);
        });
        row.addEventListener("click", function () {
          if (disabled) return;
          if (children && children.length) { openChildren(); return; }
          closeMenu();
          if (item.onClick) item.onClick();
        });
        menu.appendChild(row);
      }
      document.body.appendChild(menu);
      const rect = anchorRect;
      let left = options.submenu ? rect.right + 4 : rect.left;
      let top = options.submenu ? rect.top - 5 : (point ? rect.top : rect.bottom + 4);
      if (left + menu.offsetWidth > root.innerWidth - 8) left = options.submenu ? rect.left - menu.offsetWidth - 4 : root.innerWidth - menu.offsetWidth - 8;
      if (top + menu.offsetHeight > root.innerHeight - 8) top = Math.max(8, root.innerHeight - menu.offsetHeight - 8);
      menu.style.left = Math.max(8, left) + "px";
      menu.style.top = Math.max(8, top) + "px";
      openMenus[depth] = menu;
      openMenu = openMenus[0];
      if (depth === 0 && !point) { openMenuAnchor = anchor; anchor.classList.add("active"); }
      setTimeout(function () {
        document.addEventListener("pointerdown", onMenuOutside, true);
      }, 0);
    }

    const DOC_COLOR_GRID = [
      ["#000000", "#5b0f00", "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#073763", "#20124d", "#4c1130"],
      ["#434343", "#85200c", "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#0b5394", "#351c75", "#741b47"],
      ["#666666", "#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#674ea7", "#a64d79"],
      ["#999999", "#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6fa8dc", "#8e7cc3", "#c27ba0"],
      ["#b7b7b7", "#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#9fc5e8", "#b4a7d6", "#d5a6bd"],
      ["#ffffff", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"]
    ];

    function paletteColorValue(value) {
      if (typeof value === "string") return value.trim();
      if (!value || typeof value !== "object") return "";
      return paletteColorValue(value.color || value.value || value.fallback);
    }

    function brandPaletteColors() {
      const values = [];
      const seen = new Set();
      const add = function (value) {
        if (Array.isArray(value)) { for (const item of value) add(item); return; }
        const color = paletteColorValue(value);
        const key = color.toLowerCase();
        if (!color || seen.has(key)) return;
        seen.add(key); values.push(color);
      };
      const context = isObj(opts.themeContext) ? opts.themeContext : {};
      const branding = isObj(context.branding) ? context.branding : {};
      const brandingColors = isObj(branding.colors) ? branding.colors : {};
      add(brandingColors.palette);
      for (const key of ["primary", "secondary", "accent", "brand", "supporting"]) add(brandingColors[key] || branding[key]);
      const theme = currentTheme();
      const themeColors = theme && theme.tokens && isObj(theme.tokens.colors) ? theme.tokens.colors : {};
      for (const key of ["primary", "secondary", "accent", "palette_1", "palette_2", "palette_3", "palette_4", "palette_5", "palette_6"]) add(themeColors[key]);
      add(editorBrandingPalette().primary);
      return values;
    }

    function recordColorUse(value) {
      const color = paletteColorValue(value);
      if (!color || color === "transparent") return;
      const key = color.toLowerCase();
      const prior = state.colorUsage[key] || {};
      state.colorUsage[key] = { color: color, count: Math.max(0, Number(prior.count) || 0) + 1, used_at: Date.now() };
      try { if (root.localStorage) root.localStorage.setItem("fmde_color_usage_v1", JSON.stringify(state.colorUsage)); } catch (err) { /* private mode */ }
    }

    function frequentPaletteColors() {
      const brand = brandPaletteColors();
      const seen = new Set(brand.map(function (color) { return color.toLowerCase(); }));
      const frequent = Object.keys(state.colorUsage || {}).map(function (key) { return state.colorUsage[key]; }).filter(Boolean).sort(function (a, b) {
        return (Number(b.count) || 0) - (Number(a.count) || 0) || (Number(b.used_at) || 0) - (Number(a.used_at) || 0);
      });
      const colors = brand.map(function (color) { return { color: color, brand: true }; });
      for (const item of frequent) {
        const color = paletteColorValue(item.color);
        const key = color.toLowerCase();
        if (!color || seen.has(key)) continue;
        seen.add(key); colors.push({ color: color, brand: false });
      }
      return colors.slice(0, 10);
    }

    function showColorPalette(anchor, current, options) {
      const anchorRect = anchor.getBoundingClientRect();
      options = options || {};
      let selectedColor = current && current !== "transparent" ? String(current) : "#ffffff";
      let selectedOpacity = Math.max(0, Math.min(1, num(options.opacity, 1)));
      closeMenu();
      const menu = applyEditorBranding(el("div", { class: "fmde-menu fmde-color-menu", role: "dialog", "aria-label": options.label || "Choose color" }));
      const grid = el("div", { class: "fmde-color-grid" });
      const choose = function (value) {
        recordColorUse(value);
        if (value === "transparent" || !options.showOpacity) closeMenu();
        else {
          selectedColor = value;
          menu.querySelectorAll(".fmde-color-chip[data-color]").forEach(function (chip) { chip.classList.toggle("selected", chip.getAttribute("data-color").toLowerCase() === String(value).toLowerCase()); });
        }
        if (options.onPick) options.onPick(value, selectedOpacity);
      };
      for (const row of DOC_COLOR_GRID) {
        for (const color of row) {
          const swatch = el("button", {
            type: "button",
            class: "fmde-color-chip" + (String(current).toLowerCase() === color ? " selected" : ""),
            title: color,
            "aria-label": color,
            "data-color": color,
            style: "background:" + color
          });
          swatch.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
          swatch.addEventListener("click", (function (value) { return function () { choose(value); }; })(color));
          grid.appendChild(swatch);
        }
      }
      menu.appendChild(grid);
      const custom = el("div", { class: "fmde-color-custom" });
      if (options.allowNone) {
        const none = el("button", { type: "button", class: "fmde-color-chip fmde-color-none" + (current === "transparent" ? " selected" : ""), title: (globalThis.PlatformLanguage?.text("doc-editor","m_2d4ff8a83b1b5c","None") ?? "None"), "aria-label": "No color" });
        none.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        none.addEventListener("click", function () { choose("transparent"); });
        custom.appendChild(none);
      }
      custom.appendChild(el("span", { text: "Custom" }));
      const picker = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(String(current)) ? current : "#1a73e8", "aria-label": "Custom color" });
      picker.addEventListener("input", function () { choose(picker.value); });
      custom.appendChild(picker);
      menu.appendChild(custom);
      if (options.showOpacity) {
        const opacityRow = el("div", { class: "fmde-color-opacity" });
        const opacityHead = el("div", { class: "fmde-color-opacity-head" });
        opacityHead.appendChild(el("span", { text: "Translucency" }));
        const opacityValue = el("span", { text: Math.round((1 - selectedOpacity) * 100) + "%" });
        opacityHead.appendChild(opacityValue);
        const opacitySlider = el("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round((1 - selectedOpacity) * 100)), "aria-label": "Background translucency" });
        opacitySlider.addEventListener("input", function () {
          selectedOpacity = 1 - Number(opacitySlider.value) / 100;
          opacityValue.textContent = opacitySlider.value + "%";
          if (options.onPick) options.onPick(selectedColor, selectedOpacity);
        });
        opacityRow.appendChild(opacityHead);
        opacityRow.appendChild(opacitySlider);
        menu.appendChild(opacityRow);
      }
      const frequent = el("div", { class: "fmde-color-frequent" });
      frequent.appendChild(el("div", { class: "fmde-color-frequent-label", text: "Brand & frequently used" }));
      const frequentRow = el("div", { class: "fmde-color-frequent-row" });
      for (const item of frequentPaletteColors()) {
        const swatch = el("button", { type: "button", class: "fmde-color-chip" + (item.brand ? " brand" : "") + (String(current).toLowerCase() === item.color.toLowerCase() ? " selected" : ""), title: (item.brand ? "Brand color: " : "Frequently used: ") + item.color, "aria-label": (item.brand ? "Brand color " : "Frequently used color ") + item.color, "data-color": item.color, style: "background:" + item.color });
        swatch.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        swatch.addEventListener("click", (function (value) { return function () { choose(value); }; })(item.color));
        frequentRow.appendChild(swatch);
      }
      frequent.appendChild(frequentRow);
      menu.appendChild(frequent);
      if (typeof options.onRemoveImage === "function") {
        const removeImage = el("button", { type: "button", class: "fmde-color-remove-image", html: iconSvg("trash") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_bb985683a1745d","Remove background image") ?? "Remove background image")}</span>` });
        removeImage.addEventListener("click", function () { closeMenu(); options.onRemoveImage(); });
        menu.appendChild(removeImage);
      }
      document.body.appendChild(menu);
      const rect = anchorRect;
      menu.style.left = Math.max(8, Math.min(rect.left, root.innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = (rect.bottom + 4) + "px";
      openMenu = menu;
      openMenus = [menu];
      openMenuAnchor = anchor;
      anchor.classList.add("active");
      openMenuAnchor = anchor;
      anchor.classList.add("active");
      setTimeout(function () { document.addEventListener("pointerdown", onMenuOutside, true); }, 0);
    }

    // ---- toolbar -----------------------------------------------------------------------------------

    function fitDocToolbar() {
      if (!dom.toolbar || state.mode !== "doc") return;
      const priorities = ["fmde-doc-list", "fmde-doc-para", "fmde-doc-insert", "fmde-doc-utility", "fmde-doc-style", "fmde-doc-format", "fmde-doc-zoom", "fmde-doc-history", "fmde-doc-dictation", "fmde-tb-profile", "fmde-doc-font", "fmde-doc-size"];
      for (const className of priorities) {
        const item = dom.toolbar.querySelector("." + className);
        if (item) item.classList.remove("fmde-overflowed");
      }
      for (const className of priorities) {
        if (dom.toolbar.scrollWidth <= dom.toolbar.clientWidth) break;
        const item = dom.toolbar.querySelector("." + className);
        if (item) item.classList.add("fmde-overflowed");
      }
    }

    function hasDocumentAction(name) {
      return !!((opts.documentActions || {})[name]) || typeof opts.onDocumentAction === "function";
    }

    function invokeDocumentAction(name, payload) {
      const actions = opts.documentActions || {};
      const action = actions[name] || (typeof opts.onDocumentAction === "function" ? function (data) { return opts.onDocumentAction(name, data); } : null);
      if (!action) { showStatus(name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ") + " is unavailable here", true); return Promise.resolve(null); }
      try {
        return Promise.resolve(action(Object.assign({ document: M.deepClone(state.doc), mode: state.mode }, payload || {}))).catch(function (error) {
          showStatus((error && error.message) || "That action could not be completed", true);
          return null;
        });
      } catch (error) {
        showStatus((error && error.message) || "That action could not be completed", true);
        return Promise.resolve(null);
      }
    }

    function hasDocumentAction(name) {
      return typeof (opts.documentActions && opts.documentActions[name]) === "function" || typeof opts.onDocumentAction === "function";
    }

    function showEditorDialog(title, bodyHtml, onReady) {
      const backdrop = applyEditorBranding(el("div", { class: "fmde-dialog-backdrop" }));
      const dialog = el("div", { class: "fmde-dialog", role: "dialog", "aria-modal": "true", "aria-label": title, html: "<h2>" + esc(title) + "</h2>" + bodyHtml });
      backdrop.appendChild(dialog);
      const close = function () { backdrop.remove(); };
      backdrop.addEventListener("pointerdown", function (event) { if (event.target === backdrop) close(); });
      dialog.querySelectorAll("[data-dialog-close]").forEach(function (button) { button.addEventListener("click", close); });
      document.body.appendChild(backdrop);
      if (onReady) onReady(dialog, close);
      return { el: dialog, close: close };
    }

    function documentTextStats() {
      let text = "";
      M.walkNodes(state.doc, function (node) {
        if (node.type !== "text") return;
        for (const block of (node.props && node.props.blocks) || []) {
          text += (block.runs || []).map(function (run) { return String(run.text || ""); }).join("") + "\n";
        }
      });
      const trimmed = text.trim();
      return { words: trimmed ? trimmed.split(/\s+/).length : 0, characters: text.replace(/\n$/, "").length, charactersNoSpaces: text.replace(/\s/g, "").length };
    }

    function showWordCount() {
      const stats = documentTextStats();
      showEditorDialog("Word count", '<div class="fmde-dialog-grid"><div><strong>' + stats.words + `</strong>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9cfe68a1a461bd"," words") ?? " words")}</div><div><strong>` + stats.characters + `</strong>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_694353e5faf102"," characters") ?? " characters")}</div><div><strong>` + stats.charactersNoSpaces + `</strong>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_496f2db24d5790"," characters excluding spaces") ?? " characters excluding spaces")}</div></div><div class="fmde-dialog-actions"><button type="button" class="primary" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div>`);
    }

    // ---- find & replace (Docs parity: navigation + highlight + match case) ----

    function computeFindMatches(query, matchCase) {
      const matches = [];
      const needle = matchCase ? String(query) : String(query).toLowerCase();
      if (!needle) return matches;
      M.walkNodes(state.doc, function (node) {
        if (node.type !== "text") return;
        for (const block of (node.props && node.props.blocks) || []) {
          const text = (block.runs || []).map(function (run) { return String(run.text || ""); }).join("");
          const hay = matchCase ? text : text.toLowerCase();
          let at = hay.indexOf(needle);
          while (at !== -1) {
            matches.push({ node_id: node.id, block_id: block.id, offset: at, length: needle.length });
            at = hay.indexOf(needle, at + Math.max(1, needle.length));
          }
        }
      });
      return matches;
    }

    /** Replace [offset, offset+length) of a block's flattened text with
     *  `insert`, preserving run boundaries/styles around the splice. */
    function spliceBlockText(block, offset, length, insert) {
      let pos = 0;
      let inserted = false;
      const runs = [];
      for (const run of block.runs || []) {
        const text = String(run.text || "");
        const start = pos;
        const end = pos + text.length;
        let keep = "";
        if (start < offset) keep += text.slice(0, Math.min(text.length, offset - start));
        if (!inserted && end > offset) { keep += insert; inserted = true; }
        if (end > offset + length) keep += text.slice(Math.max(0, offset + length - start));
        pos = end;
        if (keep !== "") runs.push({ ...run, text: keep });
      }
      if (!inserted && insert) runs.push({ text: insert });
      block.runs = runs.length ? runs : [{ text: "" }];
    }

    function refreshFindHighlights() {
      if (!(root.CSS && root.CSS.highlights && root.Highlight)) return;
      root.CSS.highlights.delete("fmde-find");
      root.CSS.highlights.delete("fmde-find-active");
      const session = state.findSession;
      if (!session || state.mode !== "doc" || !session.matches.length) return;
      const rest = [];
      const active = [];
      session.matches.forEach(function (match, index) {
        const range = docProjection.domRangeFor(match.node_id, match.block_id, match.offset, match.length);
        if (!range) return;
        (index === session.index ? active : rest).push(range);
      });
      if (rest.length) root.CSS.highlights.set("fmde-find", new root.Highlight(...rest));
      if (active.length) root.CSS.highlights.set("fmde-find-active", new root.Highlight(...active));
    }

    function closeFindPanel() {
      state.findSession = null;
      if (root.CSS && root.CSS.highlights) {
        root.CSS.highlights.delete("fmde-find");
        root.CSS.highlights.delete("fmde-find-active");
      }
      if (dom.findPanel) { dom.findPanel.remove(); dom.findPanel = null; }
    }

    function showFindReplace() {
      if (dom.findPanel) { dom.findPanel.querySelector("[data-find-text]").focus(); return; }
      const session = { query: "", matchCase: false, matches: [], index: -1 };
      state.findSession = session;
      const panel = applyEditorBranding(el("div", { class: "fmde-find-panel", role: "dialog", "aria-label": "Find and replace" }));
      panel.innerHTML =
        `<div class="fmde-find-row"><input data-find-text placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_7d4411d2eb6bae","Find in document") ?? "Find in document")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_7d4411d2eb6bae","Find in document") ?? "Find in document")}">` +
        `<span class="fmde-find-count" data-find-count>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8fe614199d45ec","0 of 0") ?? "0 of 0")}</span>` +
        ("<button type=\"button\" class=\"fmde-btn\" data-find-prev title=\"" + (globalThis.PlatformLanguage?.htmlText("doc-editor","m_7bb92b42521a48","Previous match") ?? "Previous match") + "\">") + iconSvg("chevleft") + '</button>' +
        ("<button type=\"button\" class=\"fmde-btn\" data-find-next title=\"" + (globalThis.PlatformLanguage?.htmlText("doc-editor","m_56fa9b425ac7d4","Next match") ?? "Next match") + "\">") + iconSvg("chevright") + '</button>' +
        ("<button type=\"button\" class=\"fmde-btn\" data-find-close title=\"" + (globalThis.PlatformLanguage?.htmlText("doc-editor","m_3742924668fb10","Close") ?? "Close") + "\">") + iconSvg("x") + '</button></div>' +
        `<div class="fmde-find-row"><input data-replace-text placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_15e0cb625dcebb","Replace with") ?? "Replace with")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_15e0cb625dcebb","Replace with") ?? "Replace with")}">` +
        `<button type="button" class="fmde-btn fmde-btn-labeled" data-replace-one>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_4432ffeeddd964","Replace") ?? "Replace")}</button>` +
        `<button type="button" class="fmde-btn fmde-btn-labeled" data-replace-all>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_f486a497c3f970","Replace all") ?? "Replace all")}</button></div>` +
        `<label class="fmde-find-case"><input type="checkbox" data-find-case>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_f6501bf56ae612"," Match case") ?? " Match case")}</label>`;
      dom.root.appendChild(panel);
      dom.findPanel = panel;
      const findInput = panel.querySelector("[data-find-text]");
      const replaceInput = panel.querySelector("[data-replace-text]");
      const countEl = panel.querySelector("[data-find-count]");
      const updateCount = function () {
        countEl.textContent = session.matches.length ? (session.index + 1) + " of " + session.matches.length : "0 of 0";
      };
      const scrollToActive = function () {
        const match = session.matches[session.index];
        if (!match) return;
        const range = docProjection.domRangeFor(match.node_id, match.block_id, match.offset, match.length);
        const target = range && (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer);
        if (target && target.scrollIntoView) { allowExplicitCanvasScroll(); target.scrollIntoView({ block: "center", behavior: "smooth" }); }
      };
      const recompute = function (preserveIndex) {
        session.query = findInput.value;
        session.matchCase = panel.querySelector("[data-find-case]").checked;
        session.matches = computeFindMatches(session.query, session.matchCase);
        if (!session.matches.length) session.index = -1;
        else if (preserveIndex) session.index = Math.min(Math.max(0, session.index), session.matches.length - 1);
        else session.index = 0;
        updateCount();
        refreshFindHighlights();
      };
      const step = function (delta) {
        if (!session.matches.length) return;
        session.index = (session.index + delta + session.matches.length) % session.matches.length;
        updateCount();
        refreshFindHighlights();
        scrollToActive();
      };
      const replaceCurrent = function () {
        const match = session.matches[session.index];
        if (!match) return;
        const found = M.findNode(state.doc, match.node_id);
        if (!found) return;
        const blocks = M.deepClone((found.node.props && found.node.props.blocks) || []);
        const block = blocks.find(function (item) { return item.id === match.block_id; });
        if (!block) return;
        spliceBlockText(block, match.offset, match.length, String(replaceInput.value || ""));
        runCommands([{ type: "text.edit", node_id: match.node_id, blocks: blocks }], "find-replace");
        recompute(true);
        scrollToActive();
      };
      const replaceAll = function () {
        const needle = String(findInput.value || "");
        if (!needle) return;
        const matchCase = panel.querySelector("[data-find-case]").checked;
        const replacement = String(replaceInput.value || "");
        const commands = [];
        let count = 0;
        M.walkNodes(state.doc, function (node) {
          if (node.type !== "text") return;
          const blocks = M.deepClone((node.props && node.props.blocks) || []);
          let changed = false;
          for (const block of blocks) {
            const text = block.runs.map(function (run) { return String(run.text || ""); }).join("");
            const hay = matchCase ? text : text.toLowerCase();
            const query = matchCase ? needle : needle.toLowerCase();
            const spots = [];
            let at = hay.indexOf(query);
            while (at !== -1) { spots.push(at); at = hay.indexOf(query, at + Math.max(1, query.length)); }
            // Splice back-to-front so earlier offsets stay valid.
            for (let i = spots.length - 1; i >= 0; i -= 1) { spliceBlockText(block, spots[i], needle.length, replacement); changed = true; count += 1; }
          }
          if (changed) commands.push({ type: "text.edit", node_id: node.id, blocks: blocks });
        });
        if (commands.length) runCommands(commands, "find-replace");
        showStatus(count ? "Replaced " + count + (count === 1 ? " match" : " matches") : "No matches found", !count);
        recompute(false);
      };
      findInput.addEventListener("input", function () { recompute(false); });
      panel.querySelector("[data-find-case]").addEventListener("change", function () { recompute(false); });
      panel.querySelector("[data-find-next]").addEventListener("click", function () { step(1); });
      panel.querySelector("[data-find-prev]").addEventListener("click", function () { step(-1); });
      panel.querySelector("[data-find-close]").addEventListener("click", closeFindPanel);
      panel.querySelector("[data-replace-one]").addEventListener("click", replaceCurrent);
      panel.querySelector("[data-replace-all]").addEventListener("click", replaceAll);
      findInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); step(ev.shiftKey ? -1 : 1); }
        if (ev.key === "Escape") { ev.preventDefault(); closeFindPanel(); }
      });
      replaceInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); replaceCurrent(); }
        if (ev.key === "Escape") { ev.preventDefault(); closeFindPanel(); }
      });
      findInput.focus();
    }

    function applyPageSetup(config) {
      const orientation = config.orientation === "landscape" ? "landscape" : "portrait";
      const size = config.size === "custom" ? { w_pt: Math.max(144, Number(config.width) * 72), h_pt: Math.max(144, Number(config.height) * 72) } : config.size;
      const box = {
        top: Math.max(0, Number(config.top) * 72), right: Math.max(0, Number(config.right) * 72),
        bottom: Math.max(0, Number(config.bottom) * 72), left: Math.max(0, Number(config.left) * 72)
      };
      const preview = M.deepClone(state.doc);
      preview.settings = preview.settings || {}; preview.settings.paper = preview.settings.paper || {};
      preview.settings.paper.size = size; preview.settings.paper.orientation = orientation;
      const paper = M.paperDimensions(preview);
      const commands = [{ type: "doc.set", prop: "settings.paper.size", value: size }, { type: "doc.set", prop: "settings.paper.orientation", value: orientation }];
      for (const id of Object.keys(state.doc.chains || {})) commands.push({ type: "chain.set_defaults", chain_id: id, defaults: { page_defaults: { margins_pt: box } } });
      M.walkNodes(state.doc, function (node) {
        const region = node && node.props && node.props.page_region;
        if (!region) return;
        let frame;
        if (region === "body") frame = { ...node.frame, x: box.left, y: box.top, w: Math.max(72, paper.w_pt - box.left - box.right), h: Math.max(72, paper.h_pt - box.top - box.bottom) };
        if (region === "header") frame = { ...node.frame, x: box.left, y: Math.max(12, box.top / 3), w: Math.max(72, paper.w_pt - box.left - box.right), h: Math.max(24, box.top / 2 - 6) };
        if (region === "footer") frame = { ...node.frame, x: box.left, y: paper.h_pt - Math.max(42, box.bottom * .75), w: Math.max(72, paper.w_pt - box.left - box.right), h: Math.max(24, box.bottom / 2 - 6) };
        if (frame) commands.push({ type: "node.set", node_id: node.id, prop: "frame", value: frame });
      });
      runCommands(commands, "page-setup");
    }

    function showPageSetup() {
      const formatMarginInches = function (points) {
        return String(Math.round((num(points, 72) / 72 + Number.EPSILON) * 100) / 100);
      };
      const orientation = M.getPath(state.doc, "settings.paper.orientation") || "portrait";
      const rawSize = M.getPath(state.doc, "settings.paper.size") || "letter";
      const dimsNow = M.paperDimensions(state.doc);
      const customDims = rawSize && typeof rawSize === "object" ? rawSize : dimsNow;
      const margins = M.getPath(state.doc, "chains.body.page_defaults.margins_pt") || { top: 72, right: 72, bottom: 72, left: 72 };
      const themeDisabled = M.getPath(state.doc, "metadata.theme_disabled") === true;
      const aliases = {
        thm_triangles: { name: "Triangles", preview: "triangles", margins_pt: { top: 104, right: 64, bottom: 104, left: 64 } },
        thm_margin: { name: "Left border", preview: "left-border", margins_pt: { top: 48, right: 48, bottom: 48, left: 104 } },
        thm_clean: { name: "Simple", preview: "simple", margins_pt: { top: 80, right: 48, bottom: 48, left: 48 } }
      };
      const catalogThemes = (opts.catalog && opts.catalog.themes) || [];
      const currentThemeId = M.getPath(state.doc, "theme_ref.theme_id") || (!themeDisabled && catalogThemes[0] && (catalogThemes[0].id || catalogThemes[0].theme_id)) || "";
      const preferredStyleOrder = ["thm_triangles", "thm_margin", "thm_clean"];
      const styleThemes = catalogThemes.filter(function (theme) {
        return theme && String(theme.status || "active").toLowerCase() !== "archived" && isObj(theme.definition || theme);
      }).slice().sort(function (a, b) {
        const aId = a.id || a.theme_id; const bId = b.id || b.theme_id;
        const ai = preferredStyleOrder.indexOf(aId); const bi = preferredStyleOrder.indexOf(bId);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return String(a.name || aId).localeCompare(String(b.name || bId));
      });
      const pageSetupForStyle = function (theme, fallback) {
        const definition = isObj(theme && theme.definition) ? theme.definition : {};
        const explicit = isObj(definition.page_setup) ? definition.page_setup : {};
        const paper = isObj(explicit.paper) ? explicit.paper : {};
        const masters = Array.isArray(definition.page_masters) ? definition.page_masters : [];
        const master = masters.find(function (item) { return M.getPath(item, "match.role") === "*"; }) || masters[0] || {};
        const inset = isObj(explicit.margins_pt) ? explicit.margins_pt : (isObj(master.content_inset) ? master.content_inset : fallback);
        return {
          margins_pt: { top: num(inset && inset.top, 72), right: num(inset && inset.right, 72), bottom: num(inset && inset.bottom, 72), left: num(inset && inset.left, 72) },
          size: explicit.size || paper.size || null,
          orientation: explicit.orientation || paper.orientation || null,
          page_background: explicit.page_background === undefined ? null : explicit.page_background
        };
      };
      const styleCards = [{ id: "", name: "No style", description: (globalThis.PlatformLanguage?.text("doc-editor","m_1d608b0726d77f","Plain page without decorative chrome") ?? "Plain page without decorative chrome"), preview: "none", version: 1, setup: pageSetupForStyle(null, { top: 72, right: 72, bottom: 72, left: 72 }) }].concat(styleThemes.map(function (theme) { const id = theme.id || theme.theme_id; const alias = aliases[id] || {}; return { id: id, name: alias.name || theme.name || id, description: theme.description || "Apply this page style", preview: alias.preview || "simple", version: theme.version || theme.current_version || 1, setup: pageSetupForStyle(theme, alias.margins_pt) }; }));
      const html = `<section class="fmde-template-section"><div class="fmde-page-section-head"><h3>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_4495434b41ec4e","Page style") ?? "Page style")}</h3><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_5193d553b4ad9e","Choose the visual treatment for every page. Your document content is preserved.") ?? "Choose the visual treatment for every page. Your document content is preserved.")}</span></div><div class="fmde-template-grid">` + styleCards.map(function (style) { return '<button type="button" class="fmde-template-card fmde-style-card' + (style.id === currentThemeId ? ' selected' : '') + '" data-theme-id="' + esc(style.id) + '" data-theme-version="' + esc(style.version) + '"><span class="fmde-template-preview ' + esc(style.preview) + '"><i></i><i></i><i></i></span><b>' + esc(style.name) + '</b><small>' + esc(style.description) + '</small></button>'; }).join("") + '</div></section>' +
        `<section class="fmde-page-options"><div class="fmde-page-section-head"><h3>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_54c1f2ff02a0e7","Page format") ?? "Page format")}</h3><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ac1d07223bdf50","Choose a starting margin preset or enter each side precisely.") ?? "Choose a starting margin preset or enter each side precisely.")}</span></div><div class="fmde-page-presets"><button type="button" data-margin-preset="normal"><b>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9a27adafe8f638","Normal") ?? "Normal")}</b><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_a894ef24605cb2","1 in all sides") ?? "1 in all sides")}</span></button><button type="button" data-margin-preset="narrow"><b>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_32a5871815538b","Narrow") ?? "Narrow")}</b><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9623c74afaa2bb","0.5 in all sides") ?? "0.5 in all sides")}</span></button><button type="button" data-margin-preset="wide"><b>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9246870f32f935","Wide") ?? "Wide")}</b><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_0a74a91f67d09a","1 in vertical, 2 in horizontal") ?? "1 in vertical, 2 in horizontal")}</span></button></div>` +
        `<div class="fmde-dialog-grid fmde-page-grid"><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_b128ef8b7d700d","Paper size") ?? "Paper size")}<select data-page-size><option value="letter">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cfd7e44a195bbf","Letter (8.5 × 11 in)") ?? "Letter (8.5 × 11 in)")}</option><option value="legal">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_1e81213c70c664","Legal (8.5 × 14 in)") ?? "Legal (8.5 × 14 in)")}</option><option value="a4">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ad6459807c5700","A4 (8.27 × 11.69 in)") ?? "A4 (8.27 × 11.69 in)")}</option><option value="custom">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_6edcf7d7d41112","Custom") ?? "Custom")}</option></select></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_94e1ced461b291","Orientation") ?? "Orientation")}<select data-page-orientation><option value="portrait">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_f00ff8e935b5c7","Portrait") ?? "Portrait")}</option><option value="landscape">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_2cb32e3d02e5f4","Landscape") ?? "Landscape")}</option></select></label><label data-custom-width>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9e862d6918de50","Width (in)") ?? "Width (in)")}<input type="number" min="2" step="0.01" data-page-width></label><label data-custom-height>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cb2cea2cc10249","Height (in)") ?? "Height (in)")}<input type="number" min="2" step="0.01" data-page-height></label></div><div class="fmde-page-color-row"><label class="fmde-page-color-field"><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_6bf0fde24555a0","Page color") ?? "Page color")}</span><input class="fmde-page-color-swatch" type="color" data-page-color></label><label class="fmde-page-color-toggle"><input type="checkbox" data-page-color-show>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_b19ed196a1c77c"," Show page color") ?? " Show page color")}</label></div>` +
        `<h3 class="fmde-dialog-subhead">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9849bdadabb6fc","Margins (inches)") ?? "Margins (inches)")}</h3><div class="fmde-page-margin-grid"><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_daab28e9def67b","Top") ?? "Top")}<input type="number" min="0" step="0.01" data-margin-top></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ebdd2a01ebccd1","Bottom") ?? "Bottom")}<input type="number" min="0" step="0.01" data-margin-bottom></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_5795191103b183","Left") ?? "Left")}<input type="number" min="0" step="0.01" data-margin-left></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_78a58a617fa010","Right") ?? "Right")}<input type="number" min="0" step="0.01" data-margin-right></label></div></section><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="primary" data-page-apply>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8d9acfab4d9414","Apply setup") ?? "Apply setup")}</button></div>`;
      showEditorDialog("Page setup", html, function (dialog, close) {
        dialog.classList.add("fmde-page-setup-dialog");
        let selectedThemeId = currentThemeId;
        let selectedThemeVersion = 1;
        const sizeSelect = dialog.querySelector("[data-page-size]");
        const pageBackground = M.getPath(state.doc, "settings.page_background") || "";
        const pageColorInput = dialog.querySelector("[data-page-color]");
        const showPageColorInput = dialog.querySelector("[data-page-color-show]");
        const pageColorRow = dialog.querySelector(".fmde-page-color-row");
        const syncPageColor = function () { const shown = showPageColorInput.checked; pageColorInput.disabled = !shown; pageColorRow.classList.toggle("color-off", !shown); };
        pageColorInput.value = /^#[0-9a-f]{6}$/i.test(pageBackground) ? pageBackground : "#ffffff";
        showPageColorInput.checked = !!pageBackground;
        pageColorInput.addEventListener("input", function () { showPageColorInput.checked = true; syncPageColor(); });
        showPageColorInput.addEventListener("change", syncPageColor);
        syncPageColor();
        dialog.querySelector("[data-page-orientation]").value = orientation;
        sizeSelect.value = typeof rawSize === "string" && ["letter", "legal", "a4"].includes(rawSize) ? rawSize : "custom";
        dialog.querySelector("[data-page-width]").value = (customDims.w_pt / 72).toFixed(2);
        dialog.querySelector("[data-page-height]").value = (customDims.h_pt / 72).toFixed(2);
        for (const side of ["top", "right", "bottom", "left"]) dialog.querySelector("[data-margin-" + side + "]").value = formatMarginInches(margins[side]);
        const syncCustom = function () { const custom = sizeSelect.value === "custom"; dialog.querySelector("[data-custom-width]").hidden = !custom; dialog.querySelector("[data-custom-height]").hidden = !custom; }; sizeSelect.addEventListener("change", syncCustom); syncCustom();
        const applyStyleSetupToDialog = function (setup) {
          setup = setup || {};
          const inset = setup.margins_pt || {};
          for (const side of ["top", "right", "bottom", "left"]) dialog.querySelector("[data-margin-" + side + "]").value = formatMarginInches(inset[side]);
          if (setup.orientation) dialog.querySelector("[data-page-orientation]").value = setup.orientation;
          if (setup.size) {
            if (typeof setup.size === "string") sizeSelect.value = setup.size;
            else {
              sizeSelect.value = "custom";
              dialog.querySelector("[data-page-width]").value = (num(setup.size.w_pt, customDims.w_pt) / 72).toFixed(2);
              dialog.querySelector("[data-page-height]").value = (num(setup.size.h_pt, customDims.h_pt) / 72).toFixed(2);
            }
            syncCustom();
          }
          if (setup.page_background !== null && setup.page_background !== undefined) {
            showPageColorInput.checked = !!setup.page_background;
            if (/^#[0-9a-f]{6}$/i.test(String(setup.page_background))) pageColorInput.value = setup.page_background;
            syncPageColor();
          }
        };
        dialog.querySelectorAll("[data-theme-id]").forEach(function (button) {
          if ((button.dataset.themeId || "") === currentThemeId) selectedThemeVersion = Number(button.dataset.themeVersion) || 1;
          button.addEventListener("click", function () {
            selectedThemeId = button.dataset.themeId || "";
            selectedThemeVersion = Number(button.dataset.themeVersion) || 1;
            dialog.querySelectorAll("[data-theme-id]").forEach(function (card) { card.classList.toggle("selected", card === button); });
            const style = styleCards.find(function (item) { return item.id === selectedThemeId; });
            if (style) applyStyleSetupToDialog(style.setup);
          });
        });
        dialog.querySelectorAll("[data-margin-preset]").forEach(function (button) { button.addEventListener("click", function () { const p = button.dataset.marginPreset; const values = p === "narrow" ? [0.5,0.5,0.5,0.5] : p === "wide" ? [1,2,1,2] : [1,1,1,1]; ["top","right","bottom","left"].forEach(function (side, index) { dialog.querySelector("[data-margin-" + side + "]").value = values[index]; }); }); });
        dialog.querySelector("[data-page-apply]").addEventListener("click", function () {
          const button = dialog.querySelector("[data-page-apply]"); button.disabled = true; button.textContent = (globalThis.PlatformLanguage?.text("doc-editor","m_542d0e0fa65d83","Applying…") ?? "Applying…");
          if (selectedThemeId !== currentThemeId || themeDisabled === !!selectedThemeId) runCommands([
            { type: "theme.apply", theme_ref: selectedThemeId ? { theme_id: selectedThemeId, version: selectedThemeVersion } : null },
            { type: "doc.set", prop: "metadata.theme_disabled", value: !selectedThemeId }
          ], "page-style");
          const nextBackground = dialog.querySelector("[data-page-color-show]").checked ? dialog.querySelector("[data-page-color]").value : null;
          if ((nextBackground || null) !== (pageBackground || null)) runCommands([{ type: "doc.set", prop: "settings.page_background", value: nextBackground }], "page-color");
          applyPageSetup({ size: sizeSelect.value, orientation: dialog.querySelector("[data-page-orientation]").value, width: dialog.querySelector("[data-page-width]").value, height: dialog.querySelector("[data-page-height]").value, top: dialog.querySelector("[data-margin-top]").value, right: dialog.querySelector("[data-margin-right]").value, bottom: dialog.querySelector("[data-margin-bottom]").value, left: dialog.querySelector("[data-margin-left]").value }); close();
        });
      });
    }

    function showDownloadDialog() {
      const formats = [{ id: "pdf", title: (globalThis.PlatformLanguage?.text("doc-editor","m_c58d9f36a0eab4","PDF document") ?? "PDF document"), ext: ".pdf" }, { id: "doc", title: (globalThis.PlatformLanguage?.text("doc-editor","m_b4afdfdbedc631","Microsoft Word") ?? "Microsoft Word"), ext: ".doc" }, { id: "txt", title: (globalThis.PlatformLanguage?.text("doc-editor","m_ddfce0780d27c8","Plain text") ?? "Plain text"), ext: ".txt" }, { id: "json", title: (globalThis.PlatformLanguage?.text("doc-editor","m_005d5fd3ae02aa","FirstMate source") ?? "FirstMate source"), ext: ".json" }];
      showEditorDialog("Download", `<p class="fmde-dialog-note">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_3cce5afa472e9a","Choose a format for this document.") ?? "Choose a format for this document.")}</p><div class="fmde-download-grid">` + formats.map(function (f) { return '<button type="button" data-download-format="' + f.id + '"><b>' + f.title + '</b><span>' + f.ext + '</span></button>'; }).join("") + `</div><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button></div>`, function (dialog, close) {
        dialog.querySelectorAll("[data-download-format]").forEach(function (button) { button.addEventListener("click", function () { invokeDocumentAction("download", { format: button.dataset.downloadFormat }); close(); }); });
      });
    }

    function showPageNumbers() {
      const current = M.getPath(state.doc, "metadata.page_numbers");
      // First open (nothing stored yet) defaults to SHOW — opening this dialog
      // means the user wants numbers; only an explicit legacy false keeps Hide.
      const config = current && typeof current === "object" ? current : { enabled: current === undefined || current === null ? true : !!current, position: "footer", align: "center", format: "{page}", start: 1, first_page: true };
      showEditorDialog("Page numbers", `<div class="fmde-dialog-grid fmde-page-grid"><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_92999b4236dd11","Display") ?? "Display")}<select data-pn-enabled><option value="true">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_91646ccec53044","Show page numbers") ?? "Show page numbers")}</option><option value="false">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_4a1a4ccd2f8e1b","Hide page numbers") ?? "Hide page numbers")}</option></select></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_78ff1aaef0c389","Position") ?? "Position")}<select data-pn-position><option value="header">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_5024c72b09c78a","Header") ?? "Header")}</option><option value="footer">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cd4ea6358d65b3","Footer") ?? "Footer")}</option></select></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_54e993b429a6f7","Alignment") ?? "Alignment")}<select data-pn-align><option value="left">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_5795191103b183","Left") ?? "Left")}</option><option value="center">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8d654a8b9cba56","Center") ?? "Center")}</option><option value="right">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_78a58a617fa010","Right") ?? "Right")}</option></select></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cdf11b397d38fc","Format") ?? "Format")}<select data-pn-format><option value="{page}">1</option><option value="Page {page}">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_6bb8069fae869e","Page 1") ?? "Page 1")}</option><option value="Page {page} of {pages}">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ae03a526dcffae","Page 1 of 5") ?? "Page 1 of 5")}</option></select></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_7f079c853890c3","Start at") ?? "Start at")}<input type="number" min="1" data-pn-start></label><label class="fmde-check-label"><input type="checkbox" data-pn-first>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ecc67dfae558ad"," Show on first page") ?? " Show on first page")}</label></div><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="primary" data-pn-apply>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9417f96a1856fa","Apply") ?? "Apply")}</button></div>`, function (dialog, close) {
        dialog.querySelector("[data-pn-enabled]").value = String(config.enabled !== false); dialog.querySelector("[data-pn-position]").value = config.position || "footer"; dialog.querySelector("[data-pn-align]").value = config.align || "center"; dialog.querySelector("[data-pn-format]").value = config.format || "{page}"; dialog.querySelector("[data-pn-start]").value = Number(config.start) || 1; dialog.querySelector("[data-pn-first]").checked = config.first_page !== false;
        dialog.querySelector("[data-pn-apply]").addEventListener("click", function () { runCommands([{ type: "doc.set", prop: "metadata.page_numbers", value: { enabled: dialog.querySelector("[data-pn-enabled]").value === "true", position: dialog.querySelector("[data-pn-position]").value, align: dialog.querySelector("[data-pn-align]").value, format: dialog.querySelector("[data-pn-format]").value, start: Math.max(1, Number(dialog.querySelector("[data-pn-start]").value) || 1), first_page: dialog.querySelector("[data-pn-first]").checked } }], "page-numbers"); close(); });
      });
    }

    function openDocumentAgent(task) {
      const panel = state.sidePanels.find(function (item) { return item.id === "agent"; });
      if (panel) {
        state.activeInspTab = "agent";
        if (state.inspectorCollapsed) setSideCollapsed("inspector", false);
        renderInspector();
        if (task) invokeDocumentAction("agent", { task: task });
        return;
      }
      invokeDocumentAction("agent", { task: task || "" });
    }

    function showKeyboardShortcuts() {
      const groups = [
        ["General", [["Undo","Ctrl/⌘ Z"],["Redo","Ctrl/⌘ Shift Z"],["Print","Ctrl/⌘ P"],["Open","Ctrl/⌘ O"],["Search menus","Alt /"],["Keyboard shortcuts","Ctrl/⌘ /"]]],
        ["Editing", [["Cut","Ctrl/⌘ X"],["Copy","Ctrl/⌘ C"],["Paste","Ctrl/⌘ V"],["Paste without formatting","Ctrl/⌘ Shift V"],["Select all","Ctrl/⌘ A"],["Find and replace","Ctrl/⌘ H"],["Insert link","Ctrl/⌘ K"]]],
        ["Text formatting", [["Bold","Ctrl/⌘ B"],["Italic","Ctrl/⌘ I"],["Underline","Ctrl/⌘ U"],["Strikethrough","Alt Shift 5"],["Superscript","Ctrl/⌘ ."],["Subscript","Ctrl/⌘ ,"],["Clear formatting","Ctrl/⌘ \\"],["Increase font size","Ctrl/⌘ >"],["Decrease font size","Ctrl/⌘ <"]]],
        ["Paragraphs", [["Indent","Tab"],["Outdent","Shift Tab"],["Align left","Ctrl/⌘ Shift L"],["Align center","Ctrl/⌘ Shift E"],["Align right","Ctrl/⌘ Shift R"],["Justify","Ctrl/⌘ Shift J"],["Numbered list","Ctrl/⌘ Shift 7"],["Bulleted list","Ctrl/⌘ Shift 8"]]],
        ["Insert & navigate", [["Page break","Ctrl/⌘ Enter"],["Comment","Ctrl/⌘ Alt M"],["Next page","Page Down"],["Previous page","Page Up"],["Document start","Ctrl/⌘ Home"],["Document end","Ctrl/⌘ End"]]]
      ];
      const rows = groups.map(function (group) { return '<section class="fmde-shortcut-section" data-shortcut-section><h3>' + esc(group[0]) + '</h3>' + group[1].map(function (entry) { return '<div class="fmde-shortcut-row" data-shortcut-row data-search="' + esc((entry[0] + " " + entry[1]).toLowerCase()) + '"><span>' + esc(entry[0]) + '</span><kbd>' + esc(entry[1]) + '</kbd></div>'; }).join("") + '</section>'; }).join("");
      showEditorDialog("Keyboard shortcuts", `<input class="fmde-shortcut-search" data-shortcut-search placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_832195f9710eff","Search shortcuts") ?? "Search shortcuts")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9943264d3c34e2","Search keyboard shortcuts") ?? "Search keyboard shortcuts")}"><div class="fmde-shortcut-list">` + rows + `</div><div class="fmde-dialog-actions"><button type="button" class="primary" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div>`, function (dialog) {
        const input = dialog.querySelector("[data-shortcut-search]"); input.addEventListener("input", function () { const q = input.value.trim().toLowerCase(); dialog.querySelectorAll("[data-shortcut-row]").forEach(function (row) { row.hidden = !!q && !row.dataset.search.includes(q); }); dialog.querySelectorAll("[data-shortcut-section]").forEach(function (section) { section.hidden = !section.querySelector("[data-shortcut-row]:not([hidden])"); }); }); input.focus();
      });
    }

    function firstTextDescendant(node) {
      if (!node) return null;
      if (node.type === "text") return node;
      for (const child of node.children || []) {
        const found = firstTextDescendant(child);
        if (found) return found;
      }
      return null;
    }

    function visualTextContext() {
      if (state.mode !== "visual" || state.selection.length !== 1) return null;
      const info = state.nodeIndex.get(state.selection[0]);
      if (!info || !info.node) return null;
      const selected = info.node;
      if (selected.type === "shape") return { kind: "shape", textNode: selected, backgroundNode: selected };
      const textNode = selected.type === "text" ? selected : selected.type === "frame" ? firstTextDescendant(selected) : null;
      return textNode ? { kind: "text", textNode: textNode, backgroundNode: selected } : null;
    }

    function visualElementNode() {
      if (state.mode !== "visual" || state.selection.length !== 1) return null;
      const info = state.nodeIndex.get(state.selection[0]);
      return info && info.node || null;
    }

    function visualTextState(context) {
      if (!context) return null;
      if (context.kind === "shape") {
        const style = context.textNode.props && context.textNode.props.text_style || {};
        return {
          family: style.family || "Arial", size: num(style.size_pt, num(state.doc.settings && state.doc.settings.base_font_pt, 11)),
          color: style.color || defaultShapeTextColor(context.textNode), bold: num(style.weight, 500) >= 600,
          italic: !!style.italic, underline: !!style.underline
        };
      }
      const node = context.textNode;
      const font = node.style && node.style.font || {};
      const runs = [];
      for (const block of (node.props && node.props.blocks) || []) for (const run of block.runs || []) runs.push(run);
      return {
        family: font.family || "Arial", size: num(font.size_pt, num(state.doc.settings && state.doc.settings.base_font_pt, 11)),
        color: font.color || (runs[0] && runs[0].color) || "#202124",
        bold: runs.length ? runs.every(function (run) { return num(run.weight, num(font.weight, 400)) >= 600; }) : num(font.weight, 400) >= 600,
        italic: runs.length ? runs.every(function (run) { return !!run.italic; }) : font.style === "italic",
        underline: runs.length ? runs.every(function (run) { return !!run.underline; }) : false
      };
    }

    function setVisualTextValue(kind, value) {
      const context = visualTextContext();
      if (!context) return;
      const node = context.textNode;
      if (context.kind === "shape") {
        nodeSet(node.id, "props.text_style." + (kind === "bold" ? "weight" : kind), kind === "bold" ? (value ? 700 : 400) : value, "visual-text-style");
        return;
      }
      if (kind === "family" || kind === "size_pt" || kind === "color") {
        nodeSet(node.id, "style.font." + kind, value, "visual-text-style");
        return;
      }
      const blocks = M.deepClone((node.props && node.props.blocks) || []);
      for (const block of blocks) for (const run of block.runs || []) {
        if (kind === "bold") run.weight = value ? 700 : 400;
        else if (kind === "italic") run.italic = !!value;
        else if (kind === "underline") run.underline = !!value;
      }
      runCommands([{ type: "text.edit", node_id: node.id, blocks: blocks }], "visual-text-style");
    }

    function currentDocSectionNode() {
      let nodeId = null;
      const caret = docProjection && docProjection.caretTarget ? docProjection.caretTarget() : null;
      if (caret) nodeId = caret.node_id;
      if (!nodeId && state.selection.length === 1) nodeId = state.selection[0];
      let info = nodeId ? state.nodeIndex.get(rawNodeId(nodeId)) : null;
      let hops = 0;
      while (info && hops < 64) {
        if (info.node.type === "frame" && info.node.props && info.node.props.page_region) return info.node;
        info = info.parentId ? state.nodeIndex.get(info.parentId) : null;
        hops += 1;
      }
      const page = M.findPage(state.doc, state.currentPageId);
      return page && (page.page.children || []).find(function (node) { return node.props && node.props.page_region === "body"; }) || null;
    }

    function nodeBackgroundColor(node) {
      const fill = node && node.style && node.style.fill;
      if (!fill || typeof fill !== "object") return "#ffffff";
      if (fill.type === "image") return fill.overlay_color || "#ffffff";
      return fill.type === "solid" ? fill.color || "#ffffff" : "#ffffff";
    }

    function nodeBackgroundOpacity(node) {
      const fill = node && node.style && node.style.fill;
      if (!fill || typeof fill !== "object") return 1;
      if (fill.type === "image") {
        if (!fill.overlay_color) return 0.5;
        return Math.max(0, Math.min(1, num(fill.overlay_opacity, 1)));
      }
      return fill.type === "solid" ? Math.max(0, Math.min(1, num(fill.opacity, 1))) : 1;
    }

    function nodeHasBackgroundImage(node) {
      const fill = node && node.style && node.style.fill;
      return !!(fill && typeof fill === "object" && fill.type === "image" && fill.media);
    }

    function targetNodeList(target) {
      if (Array.isArray(target)) return target.filter(Boolean);
      if (target) return [target];
      const single = visualElementNode();
      return single ? [single] : [];
    }

    function consensus(nodes, getter) {
      const values = targetNodeList(nodes).map(getter);
      const first = values[0];
      const key = JSON.stringify(first);
      return { value: first, mixed: values.some(function (value) { return JSON.stringify(value) !== key; }) };
    }

    function runNodePropertyCommands(nodes, prop, valueForNode, label) {
      const commands = targetNodeList(nodes).map(function (node) {
        return { type: "node.set", node_id: node.id, prop: prop, value: valueForNode(node) };
      });
      if (commands.length) runCommands(commands, label);
    }

    function backgroundFillValue(node, color, opacity) {
      const fill = node.style && node.style.fill;
      if (fill && fill.type === "image") {
        const next = M.deepClone(fill);
        if (!color || color === "transparent") {
          delete next.overlay_color;
          delete next.overlay_opacity;
        } else {
          next.overlay_color = color;
          next.overlay_opacity = Math.max(0, Math.min(1, num(opacity, 1)));
        }
        return next;
      }
      return (!color || color === "transparent") ? null : { type: "solid", color: color, opacity: Math.max(0, Math.min(1, num(opacity, 1))) };
    }

    function setNodeBackground(nodeOrNodes, color, opacity, label) {
      runNodePropertyCommands(nodeOrNodes, "style.fill", function (node) { return backgroundFillValue(node, color, opacity); }, label || "background");
    }

    function removeNodeBackgroundImage(nodeOrNodes, label) {
      const nodes = targetNodeList(nodeOrNodes).filter(nodeHasBackgroundImage);
      runNodePropertyCommands(nodes, "style.fill", function (node) {
        const fill = node.style.fill;
        return fill.overlay_color ? { type: "solid", color: fill.overlay_color, opacity: Math.max(0, Math.min(1, num(fill.overlay_opacity, 1))) } : null;
      }, label || "background-image-remove");
    }

    function backgroundPaletteOptions(nodeOrNodes, label, commandLabel) {
      const nodes = targetNodeList(nodeOrNodes);
      const opacity = consensus(nodes, nodeBackgroundOpacity);
      return {
        label: label,
        allowNone: true,
        showOpacity: true,
        opacity: opacity.value,
        onPick: function (value, nextOpacity) { setNodeBackground(nodes, value, nextOpacity, commandLabel); },
        onRemoveImage: nodes.some(nodeHasBackgroundImage) ? function () { removeNodeBackgroundImage(nodes, commandLabel + "-image-remove"); } : null
      };
    }

    function makeBackgroundColorButton(mode) {
      const button = el("button", { type: "button", class: "fmde-btn fmde-background-color", title: mode === "doc" ? "Section background color" : "Element background color", "aria-label": mode === "doc" ? "Section background color" : "Element background color", html: '<i class="fmde-background-color-dot"></i>' });
      button.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
      button.addEventListener("click", function () {
        const target = mode === "doc" ? currentDocSectionNode() : visualElementNode();
        if (!target) return;
        showColorPalette(button, nodeBackgroundColor(target), backgroundPaletteOptions(target, mode === "doc" ? "Section background" : "Element background", mode + "-background"));
      });
      return button;
    }

    function positionCustomMenu(anchor, menu, capturedRect) {
      document.body.appendChild(menu);
      // Context-menu style buttons are removed when closeMenu() runs. Their
      // live DOM rect becomes (0,0), so callers opening a nested editor capture
      // the geometry before closing the parent menu and pass it here.
      const rect = capturedRect || anchor.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(rect.left, root.innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(rect.bottom + 4, root.innerHeight - menu.offsetHeight - 8)) + "px";
      openMenu = menu;
      openMenus = [menu];
      openMenuAnchor = anchor;
      anchor.classList.add("active");
      setTimeout(function () { document.addEventListener("pointerdown", onMenuOutside, true); }, 0);
    }

    function cornerValue(node) {
      if (!node) return 0;
      if (node.type === "shape") return Math.max(0, num(node.props && node.props.corner_radius, 0));
      const radius = node.style && node.style.radius;
      if (radius !== undefined && radius !== null) return Math.max(0, num(Array.isArray(radius) ? radius[0] : radius, 0));
      // Older visual templates briefly wrote style.corner_radius. Read that
      // alias so those elements do not appear as zero in the shared control.
      const legacy = node.style && node.style.corner_radius;
      if (legacy !== undefined && legacy !== null) return Math.max(0, num(Array.isArray(legacy) ? legacy[0] : legacy, 0));
      // Widgets often ship with a rounded visual root inside an otherwise
      // transparent node wrapper (payment, signature, etc.). Reflect the
      // radius the user can actually see; the first slider input serializes it
      // as style.radius and the renderer then makes it authoritative.
      if (node.type === "widget" && root.getComputedStyle) {
        const rendered = renderedNodeElement(node.id);
        const visualRoot = rendered && rendered.firstElementChild;
        if (visualRoot) {
          const pixels = parseFloat(root.getComputedStyle(visualRoot).borderTopLeftRadius);
          if (Number.isFinite(pixels)) return Math.max(0, roundPt(pixels / PX_PER_PT));
        }
      }
      return 0;
    }

    function setCornerValue(nodeOrNodes, value) {
      const next = Math.max(0, Math.min(100, Number(value) || 0));
      const nodes = targetNodeList(nodeOrNodes);
      const commands = nodes.map(function (node) {
        return { type: "node.set", node_id: node.id, prop: node.type === "shape" ? "props.corner_radius" : "style.radius", value: node.type === "shape" ? next : [next, next, next, next] };
      });
      if (commands.length) runCommands(commands, "corners");
    }

    function showCornersMenu(anchor, targetNode) {
      const nodes = targetNodeList(targetNode);
      if (!nodes.length) return;
      const anchorRect = anchor.getBoundingClientRect();
      closeMenu();
      const corner = consensus(nodes, cornerValue);
      const current = corner.value;
      const menu = applyEditorBranding(el("div", { class: "fmde-menu fmde-style-menu", role: "dialog", "aria-label": "Corners" }));
      if (corner.mixed) menu.classList.add("mixed");
      menu.appendChild(el("div", { class: "fmde-style-menu-title", text: "Corners" }));
      const row = el("div", { class: "fmde-style-slider-row" });
      const slider = el("input", { type: "range", min: "0", max: "100", step: "1", value: String(current), "aria-label": "Corner radius" });
      const number = el("input", { type: "number", class: "fmde-style-number", min: "0", max: "100", step: "1", value: String(current), "aria-label": "Corner radius" });
      const apply = function (value) { const next = Math.max(0, Math.min(100, Number(value) || 0)); slider.value = String(next); number.value = String(next); menu.classList.remove("mixed"); setCornerValue(nodes, next); };
      slider.addEventListener("input", function () { apply(slider.value); });
      number.addEventListener("change", function () { apply(number.value); });
      row.appendChild(slider); row.appendChild(number); menu.appendChild(row);
      positionCustomMenu(anchor, menu, anchorRect);
    }

    function strokeState(node) {
      const stroke = node && node.style && node.style.stroke || {};
      return { width: Math.max(0, num(stroke.width_pt, 0)), color: stroke.color || "#202124", dash: stroke.dash || null };
    }

    function setStroke(nodeOrNodes, changes) {
      runNodePropertyCommands(nodeOrNodes, "style.stroke", function (node) {
        const next = Object.assign({}, strokeState(node), changes || {});
        return !(next.width > 0) ? null : { color: next.color || "#202124", width_pt: next.width, dash: next.dash || null };
      }, "stroke");
    }

    function setStrokeColor(nodeOrNodes, color) {
      runNodePropertyCommands(nodeOrNodes, "style.stroke", function (node) {
        const current = strokeState(node);
        return { color: color || "#202124", width_pt: Math.max(1, current.width), dash: current.dash || null };
      }, "stroke");
    }

    function showStrokeMenu(anchor, targetNode) {
      const nodes = targetNodeList(targetNode);
      if (!nodes.length) return;
      const anchorRect = anchor.getBoundingClientRect();
      closeMenu();
      const stateConsensus = consensus(nodes, strokeState);
      const current = stateConsensus.value;
      const menu = applyEditorBranding(el("div", { class: "fmde-menu fmde-style-menu", role: "dialog", "aria-label": "Line width" }));
      if (stateConsensus.mixed) menu.classList.add("mixed");
      const presets = el("div", { class: "fmde-style-presets" });
      const specs = [
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c1b55e3df9a474","No border") ?? "No border"), width: 0, dash: null },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f585273635acb4","Solid border") ?? "Solid border"), width: Math.max(1, current.width), dash: null },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c22fa6b118e41b","Dashed border") ?? "Dashed border"), width: Math.max(1, current.width), dash: "5 3" },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d27318ce7c4a38","Dotted border") ?? "Dotted border"), width: Math.max(1, current.width), dash: "1 3" }
      ];
      for (const spec of specs) {
        const button = el("button", { type: "button", class: "fmde-style-preset" + (!stateConsensus.mixed && (spec.width === 0 ? current.width === 0 : current.width > 0 && String(current.dash || "") === String(spec.dash || "")) ? " active" : ""), title: spec.label, "aria-label": spec.label });
        button.style.setProperty("--sample-style", spec.width === 0 ? "none" : spec.dash === "1 3" ? "dotted" : spec.dash ? "dashed" : "solid");
        button.innerHTML = spec.width === 0 ? '<span class="fmde-color-none" style="display:block;width:22px;height:22px;margin:auto;border:1px solid #ccd1d8;border-radius:50%"></span>' : "<i></i>";
        button.addEventListener("click", (function (choice) { return function () { setStroke(nodes, { width: choice.width, dash: choice.dash }); closeMenu(); }; })(spec));
        presets.appendChild(button);
      }
      menu.appendChild(presets);
      menu.appendChild(el("div", { class: "fmde-style-menu-title", text: "Line width" }));
      const row = el("div", { class: "fmde-style-slider-row" });
      const slider = el("input", { type: "range", min: "0", max: "20", step: "0.5", value: String(current.width), "aria-label": "Line width" });
      const number = el("input", { type: "number", class: "fmde-style-number", min: "0", max: "20", step: "0.5", value: String(current.width), "aria-label": "Line width" });
      const apply = function (value) { const next = Math.max(0, Math.min(20, Number(value) || 0)); slider.value = String(next); number.value = String(next); menu.classList.remove("mixed"); setStroke(nodes, { width: next }); };
      slider.addEventListener("input", function () { apply(slider.value); });
      number.addEventListener("change", function () { apply(number.value); });
      row.appendChild(slider); row.appendChild(number); menu.appendChild(row);
      positionCustomMenu(anchor, menu, anchorRect);
    }

    function renderedNodeElement(nodeId) {
      const escaped = String(nodeId || "").replace(/"/g, '\\"');
      return dom.stage.querySelector('[data-node-id="' + escaped + '"], [data-node-id="' + escaped + '::part0"]');
    }

    function pageContextStyleRow(page) {
      const style = page.style || {};
      const fillState = style.fill || {};
      const stroke = style.stroke || {};
      const row = el("div", { class: "fmde-context-style-row", role: "group", "aria-label": "Page appearance" });
      const fill = el("button", { type: "button", class: "fmde-context-style-btn fmde-context-fill", title: (globalThis.PlatformLanguage?.text("doc-editor","m_249d35d121620e","Background color") ?? "Background color"), "aria-label": "Background color", html: '<i class="fmde-background-color-dot"></i>' });
      const fillColor = fillState.type === "image" ? (fillState.overlay_color || "#ffffff") : (fillState.color || "#ffffff");
      fill.style.setProperty("--tool-color", fillColor);
      fill.addEventListener("click", function (ev) {
        ev.stopPropagation();
        showColorPalette(fill, fillColor, {
          label: (globalThis.PlatformLanguage?.text("doc-editor","m_05e9e2055ef0a8","Page background") ?? "Page background"),
          allowNone: true,
          showOpacity: true,
          opacity: fillState.type === "image" ? num(fillState.overlay_opacity, fillState.overlay_color ? 1 : 0) : num(fillState.opacity, 1),
          onPick: function (color, nextOpacity) {
            const value = fillState.type === "image"
              ? Object.assign({}, fillState, { overlay_color: color, overlay_opacity: Math.max(0, Math.min(1, num(nextOpacity, 1))) })
              : { type: "solid", color: color, opacity: Math.max(0, Math.min(1, num(nextOpacity, 1))) };
            runCommands([{ type: "page.set", page_id: page.id, prop: "style.fill", value: value }], "page-background");
          },
          onRemoveImage: fillState.type === "image" ? function () {
            const replacement = fillState.overlay_color
              ? { type: "solid", color: fillState.overlay_color, opacity: num(fillState.overlay_opacity, 1) }
              : { type: "solid", color: "#ffffff", opacity: 1 };
            runCommands([{ type: "page.set", page_id: page.id, prop: "style.fill", value: replacement }], "page-background-image-remove");
          } : null
        });
      });
      const border = el("button", { type: "button", class: "fmde-context-style-btn fmde-context-border", title: (globalThis.PlatformLanguage?.text("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color"), "aria-label": "Border color", html: '<i class="fmde-border-color-dot"></i>' });
      border.style.setProperty("--tool-color", stroke.color || "#111827");
      border.addEventListener("click", function (ev) {
        ev.stopPropagation();
        showColorPalette(border, stroke.color || "#111827", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color"), onPick: function (color) {
          runCommands([{ type: "page.set", page_id: page.id, prop: "style.stroke", value: Object.assign({}, stroke, { color: color, width_pt: Math.max(1, num(stroke.width_pt, 1)) }) }], "page-border");
        } });
      });
      const width = el("button", { type: "button", class: "fmde-context-style-btn", title: (globalThis.PlatformLanguage?.text("doc-editor","m_f2accee97dc311","Line width") ?? "Line width"), "aria-label": "Line width", html: iconSvg("stroke") });
      width.addEventListener("click", function (ev) {
        ev.stopPropagation();
        showMenu(width, [0, 1, 2, 4, 8].map(function (value) { return { label: value ? value + " pt" : "No border", checked: num(stroke.width_pt, 0) === value, onClick: function () {
          runCommands([{ type: "page.set", page_id: page.id, prop: "style.stroke", value: Object.assign({}, stroke, { width_pt: value }) }], "page-border");
        } }; }));
      });
      row.appendChild(fill);
      row.appendChild(border);
      row.appendChild(width);
      return row;
    }

    function showPageContextMenu(pageId, clientX, clientY, pageEl) {
      const found = M.findPage(state.doc, pageId);
      if (!found) return;
      setSelection([]);
      state.selectedPageId = pageId;
      const page = found.page;
      const items = [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_9c71afb7467905","Duplicate page") ?? "Duplicate page"), icon: "copy", onClick: function () {
        const copy = M.deepClone(page);
        copy.id = M.generateId("pg");
        copy.name = (copy.name || "Page") + " copy";
        copy.children = M.reassignIds(copy.children || []);
        runCommands([{ type: "page.insert", page: copy, index: found.index + 1 }], "duplicate-page");
      } }];
      if (pageCroppable(page)) items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_f63541f5ddb576","Crop background") ?? "Crop background"), icon: "image", onClick: function () { startPageCropSession(pageId, pageEl); } });
      if ((state.doc.pages || []).length > 1) items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_af64ff308ca58e","Delete page") ?? "Delete page"), icon: "trash", onClick: function () { runCommands([{ type: "page.remove", page_id: pageId }], "delete-page"); } });
      showMenu(null, items, { point: { x: clientX, y: clientY }, className: "fmde-element-context fmde-page-context", before: pageContextStyleRow(page) });
    }

    function elementContextStyleRow(nodeOrNodes) {
      const nodes = targetNodeList(nodeOrNodes);
      const fillState = consensus(nodes, function (node) { return { color: nodeBackgroundColor(node), opacity: nodeBackgroundOpacity(node) }; });
      const strokeColor = consensus(nodes, function (node) { return strokeState(node).color; });
      const strokeGeometry = consensus(nodes, function (node) { const value = strokeState(node); return { width: value.width, dash: value.dash }; });
      const cornersState = consensus(nodes, cornerValue);
      const row = el("div", { class: "fmde-context-style-row", role: "group", "aria-label": "Element appearance" });
      const fill = el("button", {
        type: "button", class: "fmde-context-style-btn fmde-context-fill" + (fillState.mixed ? " mixed" : ""), title: (globalThis.PlatformLanguage?.text("doc-editor","m_249d35d121620e","Background color") ?? "Background color"), "aria-label": "Background color",
        html: '<i class="fmde-background-color-dot"></i>'
      });
      fill.style.setProperty("--tool-color", fillState.value.color);
      fill.addEventListener("click", function (ev) {
        ev.stopPropagation();
        showColorPalette(fill, fillState.value.color, backgroundPaletteOptions(nodes, "Element background", "context-background"));
      });

      const border = el("button", {
        type: "button", class: "fmde-context-style-btn fmde-context-border" + (strokeColor.mixed ? " mixed" : ""), title: (globalThis.PlatformLanguage?.text("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color"), "aria-label": "Border color",
        html: '<i class="fmde-border-color-dot"></i>'
      });
      border.style.setProperty("--tool-color", strokeColor.value);
      border.addEventListener("click", function (ev) {
        ev.stopPropagation();
        showColorPalette(border, strokeColor.value, {
          label: (globalThis.PlatformLanguage?.text("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color"),
          onPick: function (color) { setStrokeColor(nodes, color); }
        });
      });

      const width = el("button", { type: "button", class: "fmde-context-style-btn" + (strokeGeometry.mixed ? " mixed" : ""), title: (globalThis.PlatformLanguage?.text("doc-editor","m_f2accee97dc311","Line width") ?? "Line width"), "aria-label": "Line width", html: iconSvg("stroke") });
      width.addEventListener("click", function (ev) { ev.stopPropagation(); showStrokeMenu(width, nodes); });
      const corners = el("button", { type: "button", class: "fmde-context-style-btn" + (cornersState.mixed ? " mixed" : ""), title: (globalThis.PlatformLanguage?.text("doc-editor","m_818e4806db520d","Corners") ?? "Corners"), "aria-label": "Corners", html: '<i class="fmde-corners-icon"></i>' });
      corners.style.setProperty("--corner-preview", Math.min(8, cornersState.value) + "px");
      corners.addEventListener("click", function (ev) { ev.stopPropagation(); showCornersMenu(corners, nodes); });
      row.appendChild(fill); row.appendChild(border); row.appendChild(width); row.appendChild(corners);
      return row;
    }

    function responsiveContextNodes(nodeOrNodes) {
      if (!isViewDoc() || state.profile !== "website") return [];
      // Context menus live outside the editor render tree, so they stay open
      // while a command rebuilds the document index. Never keep using the node
      // objects captured when the menu opened: after the first command those
      // objects may be stale and a second position click would be calculated
      // from (and overwrite with) the original position contract.
      const nodes = targetNodeList(nodeOrNodes).map(function (node) {
        const current = node && state.nodeIndex.get(node.id);
        return current && current.node || node;
      });
      return nodes.length && nodes.every(function (node) { return responsiveHorizontalEligible(node.id); }) ? nodes : [];
    }

    /** Change the responsive mounting contract without moving the item at the
     * current viewport width. Anchor and unit are coordinate representations,
     * not alignment commands; switching either must be visually lossless. */
    function setResponsiveHorizontalPlacement(nodes, nextBasis) {
      const commands = [];
      for (const node of responsiveContextNodes(nodes)) {
        const parentId = responsiveHorizontalParentId(node.id);
        const parentWidthPx = responsiveParentWidthPx(parentId);
        const frame = gestureFrame(node);
        const itemWidthPx = Math.max(0, num(frame.w, 0) * PX_PER_PT);
        const current = M.normalizeHorizontalPosition(node.frame && node.frame.position && node.frame.position.x);
        const leftPx = M.horizontalPositionToLeft(current, parentWidthPx, itemWidthPx);
        const basis = {
          anchor: nextBasis.anchor || current.anchor,
          unit: nextBasis.unit || current.unit,
          value: current.value
        };
        commands.push({
          type: "node.set",
          node_id: node.id,
          prop: "frame.position.x",
          value: M.horizontalPositionFromLeft(leftPx, itemWidthPx, parentWidthPx, basis)
        });
      }
      return commands.length ? runCommands(commands, "responsive position") : { ok: false };
    }

    function setResponsiveResizeOptions(nodes, patch) {
      const commands = [];
      for (const node of responsiveContextNodes(nodes)) {
        const current = M.normalizeResponsiveResize(node.frame && node.frame.responsive);
        commands.push({
          type: "node.set",
          node_id: node.id,
          prop: "frame.responsive",
          value: M.normalizeResponsiveResize(Object.assign({}, current, patch || {}))
        });
      }
      return commands.length ? runCommands(commands, "responsive resize") : { ok: false };
    }

    /** Keep a persistent context menu in sync after its command re-renders the
     * canvas. The menu itself is attached to document.body and is intentionally
     * not rebuilt by renderCanvas(). */
    function refreshResponsivePositionRow(row, nodeOrNodes, nextBasis) {
      const nodes = responsiveContextNodes(nodeOrNodes);
      if (!row || !nodes.length) return;
      const anchorState = consensus(nodes, function (node) {
        return M.normalizeHorizontalPosition(node.frame && node.frame.position && node.frame.position.x).anchor;
      });
      const unitState = consensus(nodes, function (node) {
        return M.normalizeHorizontalPosition(node.frame && node.frame.position && node.frame.position.x).unit;
      });
      if (nextBasis && nextBasis.anchor) anchorState.value = nextBasis.anchor;
      if (nextBasis && nextBasis.anchor) anchorState.mixed = false;
      if (nextBasis && nextBasis.unit) unitState.value = nextBasis.unit;
      if (nextBasis && nextBasis.unit) unitState.mixed = false;
      const modeState = consensus(nodes, function (node) {
        return M.normalizeResponsiveResize(node.frame && node.frame.responsive).mode;
      });
      const widthState = consensus(nodes, function (node) {
        return M.normalizeResponsiveResize(node.frame && node.frame.responsive).width;
      });
      const heightState = consensus(nodes, function (node) {
        return M.normalizeResponsiveResize(node.frame && node.frame.responsive).height;
      });
      if (nextBasis && nextBasis.mode) { modeState.value = nextBasis.mode; modeState.mixed = false; }
      if (nextBasis && nextBasis.width) { widthState.value = nextBasis.width; widthState.mixed = false; }
      if (nextBasis && nextBasis.height) { heightState.value = nextBasis.height; heightState.mixed = false; }
      for (const button of row.querySelectorAll("[data-responsive-mode]")) {
        const active = !modeState.mixed && button.getAttribute("data-responsive-mode") === modeState.value;
        button.classList.toggle("active", active);
        button.classList.toggle("mixed", modeState.mixed);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
      const manual = row.querySelector("[data-responsive-manual]");
      if (manual) manual.hidden = !modeState.mixed && modeState.value === "auto";
      for (const button of row.querySelectorAll("[data-position-anchor]")) {
        const active = !anchorState.mixed && button.getAttribute("data-position-anchor") === anchorState.value;
        button.classList.toggle("active", active);
        button.classList.toggle("mixed", anchorState.mixed);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
      for (const button of row.querySelectorAll("[data-position-unit]")) {
        const active = !unitState.mixed && button.getAttribute("data-position-unit") === unitState.value;
        button.classList.toggle("active", active);
        button.classList.toggle("mixed", unitState.mixed);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
      for (const button of row.querySelectorAll("[data-responsive-width]")) {
        const active = !widthState.mixed && button.getAttribute("data-responsive-width") === widthState.value;
        button.classList.toggle("active", active);
        button.classList.toggle("mixed", widthState.mixed);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
      for (const button of row.querySelectorAll("[data-responsive-height]")) {
        const active = !heightState.mixed && button.getAttribute("data-responsive-height") === heightState.value;
        button.classList.toggle("active", active);
        button.classList.toggle("mixed", heightState.mixed);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    }

    function elementContextPositionRow(nodeOrNodes) {
      const nodes = responsiveContextNodes(nodeOrNodes);
      if (!nodes.length) return null;
      const row = el("div", { class: "fmde-context-responsive", role: "group", "aria-label": "Responsive layout", "data-responsive-position": "true" });
      const modeRow = el("div", { class: "fmde-context-responsive-row fmde-context-responsive-mode" });
      [["auto", "Auto resize"], ["manual", "Manual"]].forEach(function (entry) {
        const button = el("button", { type: "button", class: "fmde-context-position-btn", text: entry[1], "data-responsive-mode": entry[0], "aria-pressed": "false" });
        button.addEventListener("click", function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          setResponsiveResizeOptions(nodes, { mode: entry[0] });
          refreshResponsivePositionRow(row, nodes, { mode: entry[0] });
        });
        modeRow.appendChild(button);
      });
      row.appendChild(modeRow);

      const manual = el("div", { class: "fmde-context-responsive-manual", "data-responsive-manual": "true" });
      manual.appendChild(el("div", { class: "fmde-context-responsive-label", text: "Mount" }));
      const mountRow = el("div", { class: "fmde-context-responsive-row fmde-context-position-row" });
      [["left", "alignleft", "Mount from left"], ["center", "alignch", "Mount from center"], ["right", "alignright", "Mount from right"]].forEach(function (entry) {
        const button = el("button", {
          type: "button",
          class: "fmde-context-position-btn",
          html: iconSvg(entry[1]),
          title: entry[2],
          "aria-label": entry[2],
          "aria-pressed": "false",
          "data-position-anchor": entry[0]
        });
        button.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          setResponsiveHorizontalPlacement(nodes, { anchor: entry[0] });
          // The menu is outside the render tree. Reflect the accepted choice
          // immediately rather than leaving the opening button looking stuck.
          refreshResponsivePositionRow(row, nodes, { anchor: entry[0] });
        });
        mountRow.appendChild(button);
      });
      manual.appendChild(mountRow);

      manual.appendChild(el("div", { class: "fmde-context-responsive-label", text: "Placement" }));
      const placementRow = el("div", { class: "fmde-context-responsive-row fmde-context-responsive-choice" });
      [["px", "Fixed pixels"], ["percent", "Percentage"]].forEach(function (entry) {
        const button = el("button", { type: "button", class: "fmde-context-position-btn fmde-context-position-unit", text: entry[1], "data-position-unit": entry[0], "aria-pressed": "false" });
        button.addEventListener("click", function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          setResponsiveHorizontalPlacement(nodes, { unit: entry[0] });
          refreshResponsivePositionRow(row, nodes, { unit: entry[0] });
        });
        placementRow.appendChild(button);
      });
      manual.appendChild(placementRow);

      manual.appendChild(el("div", { class: "fmde-context-responsive-label", text: "Width" }));
      const widthRow = el("div", { class: "fmde-context-responsive-row fmde-context-responsive-choice" });
      [["fixed", "Fixed width"], ["percent", "Percentage width"]].forEach(function (entry) {
        const button = el("button", { type: "button", class: "fmde-context-position-btn", text: entry[1], "data-responsive-width": entry[0], "aria-pressed": "false" });
        button.addEventListener("click", function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          setResponsiveResizeOptions(nodes, { mode: "manual", width: entry[0] });
          refreshResponsivePositionRow(row, nodes, { mode: "manual", width: entry[0] });
        });
        widthRow.appendChild(button);
      });
      manual.appendChild(widthRow);

      manual.appendChild(el("div", { class: "fmde-context-responsive-label", text: "Height" }));
      const heightRow = el("div", { class: "fmde-context-responsive-row fmde-context-responsive-choice" });
      [["proportional", "Scale proportionally"], ["fixed", "Keep height fixed"]].forEach(function (entry) {
        const button = el("button", { type: "button", class: "fmde-context-position-btn", text: entry[1], "data-responsive-height": entry[0], "aria-pressed": "false" });
        button.addEventListener("click", function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          setResponsiveResizeOptions(nodes, { mode: "manual", height: entry[0] });
          refreshResponsivePositionRow(row, nodes, { mode: "manual", height: entry[0] });
        });
        heightRow.appendChild(button);
      });
      manual.appendChild(heightRow);
      row.appendChild(manual);
      refreshResponsivePositionRow(row, nodes);
      return row;
    }

    function elementContextHeader(nodeOrNodes) {
      const header = el("div", { class: "fmde-context-header" });
      header.appendChild(elementContextStyleRow(nodeOrNodes));
      const position = elementContextPositionRow(nodeOrNodes);
      if (position) header.appendChild(position);
      return header;
    }

    function showElementContextMenu(nodeId, clientX, clientY, sourceEl, sourceNodeId) {
      const info = state.nodeIndex.get(rawNodeId(nodeId));
      if (!info || !info.node) return;
      const node = info.node;
      const selectedNodes = state.selection.map(function (id) { const selected = state.nodeIndex.get(id); return selected && selected.node; }).filter(Boolean);
      const styleNodes = state.selection.indexOf(node.id) !== -1 && selectedNodes.length ? selectedNodes : [node];
      const memberId = rawNodeId(sourceNodeId || nodeId);
      const memberGroupId = memberId !== node.id ? groupAncestorId(memberId) : null;
      const structural = styleNodes.some(function (selected) { return isStructuralSection(selected.id); });
      const items = [];
      if (!structural) items.push(
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_28e00c7c9062c6","Bring to front") ?? "Bring to front"), icon: "front", onClick: function () { reorderSelection("front"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e4e0caabc92f90","Bring forward") ?? "Bring forward"), icon: "forward", onClick: function () { reorderSelection("forward"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_53feb04c690a79","Send backward") ?? "Send backward"), icon: "backward", onClick: function () { reorderSelection("backward"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_407ac92ba9c16c","Send to back") ?? "Send to back"), icon: "back", onClick: function () { reorderSelection("back"); } },
        "-"
      );
      if (typeof opts.elementContextItems === "function") {
        try {
          const extensionItems = opts.elementContextItems({
            node: node,
            nodes: styleNodes.slice(),
            selection: state.selection.slice(),
            document: state.doc,
            sourceNodeId: memberId
          });
          if (Array.isArray(extensionItems) && extensionItems.length) items.push.apply(items, extensionItems.concat(["-"]));
        } catch (error) {
          try { global.console && global.console.error && global.console.error("[FMDocEditor] element context menu extension failed", error); } catch (e) { /* noop */ }
        }
      }
      items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_24fc1d3519ef6a","Duplicate") ?? "Duplicate"), icon: "copy", onClick: duplicateSelection, shortcut: "Ctrl+D" });
      if (can("group") && state.selection.length > 1) items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_47914910b3588f","Group") ?? "Group"), icon: "group", onClick: groupSelection, shortcut: "Ctrl+G" });
      if (can("group") && state.selection.some(function (id) { const selected = state.nodeIndex.get(id); return selected && isGroupNode(selected.node); })) items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_9f1d18cbac69ed","Ungroup") ?? "Ungroup"), icon: "ungroup", onClick: ungroupSelection, shortcut: "Ctrl+Shift+G" });
      if (can("group") && memberGroupId === node.id) items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_febd52b67c4b8e","Remove from group") ?? "Remove from group"), icon: "ungroup", onClick: function () { removeMemberFromGroup(memberId, memberGroupId); } });
      if (styleNodes.length === 1 && nodeCroppable(node)) {
        items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_6d84414c70b27c","Crop") ?? "Crop"), icon: "image", onClick: function () {
          if (state.mode === "doc") startDocCropFromElement(sourceEl || renderedNodeElement(node.id), null);
          else startCropSession(node.id, sourceEl || renderedNodeElement(node.id));
        } });
      }
      items.push({ label: (globalThis.PlatformLanguage?.text("doc-editor","m_4fc60207629a44","Delete") ?? "Delete"), icon: "trash", onClick: deleteSelection, shortcut: "Delete" });
      showMenu(null, items, {
        point: { x: clientX, y: clientY },
        className: "fmde-element-context",
        before: elementContextHeader(styleNodes)
      });
    }

    function buildVisualTextToolbar(group) {
      const tools = group("fmde-visual-element-tools");
      dom.visualTextTools = tools;
      dom.visualBackgroundBtn = makeBackgroundColorButton("visual");
      tools.appendChild(dom.visualBackgroundBtn);
      dom.visualBorderColorBtn = el("button", { type: "button", class: "fmde-btn fmde-border-color fmde-visual-border-color", html: '<i class="fmde-border-color-dot"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color"), "aria-label": "Border color" });
      dom.visualBorderColorBtn.addEventListener("click", function () { const node = visualElementNode(); if (!node) return; const stroke = strokeState(node); showColorPalette(dom.visualBorderColorBtn, stroke.color, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color"), onPick: function (color) { setStroke(node, { color: color }); } }); });
      tools.appendChild(dom.visualBorderColorBtn);
      dom.visualStrokeBtn = iconBtn("stroke", "Line width", function () { showStrokeMenu(dom.visualStrokeBtn); });
      tools.appendChild(dom.visualStrokeBtn);
      dom.visualCornersBtn = el("button", { type: "button", class: "fmde-btn", html: '<i class="fmde-corners-icon"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_818e4806db520d","Corners") ?? "Corners"), "aria-label": "Corners" });
      dom.visualCornersBtn.addEventListener("click", function () { showCornersMenu(dom.visualCornersBtn); });
      tools.appendChild(dom.visualCornersBtn);
      const fontTools = el("div", { class: "fmde-visual-font-tools" });
      dom.visualFontTools = fontTools;
      dom.visualFontBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled fmde-fontselect", html: `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_0b2df5dd63cc66","Arial") ?? "Arial")}</span>` + iconSvg("chevdown"), title: (globalThis.PlatformLanguage?.text("doc-editor","m_ce1ba13960e5a4","Font") ?? "Font") });
      dom.visualFontBtn.addEventListener("click", function () {
        showMenu(dom.visualFontBtn, catalogFonts().map(function (font) { return { label: font.label, labelHtml: '<span style="font-family:' + esc(font.value) + '">' + esc(font.label) + "</span>", onClick: function () { setVisualTextValue("family", canonicalFontFamily(font.value)); } }; }));
      });
      fontTools.appendChild(dom.visualFontBtn);
      fontTools.appendChild(iconBtn("minus", "Decrease font size", function () { const value = visualTextState(visualTextContext()); if (value) setVisualTextValue("size_pt", Math.max(4, Math.round(value.size - 1))); }));
      dom.visualSizeBtn = el("button", { type: "button", class: "fmde-btn fmde-fontsize", text: "11", title: (globalThis.PlatformLanguage?.text("doc-editor","m_b412f18545c32b","Font size") ?? "Font size") });
      dom.visualSizeBtn.addEventListener("click", function () { showMenu(dom.visualSizeBtn, [8,9,10,11,12,14,18,24,30,36,48,60,72].map(function (size) { return { label: String(size), onClick: function () { setVisualTextValue("size_pt", size); } }; })); });
      fontTools.appendChild(dom.visualSizeBtn);
      fontTools.appendChild(iconBtn("plusplain", "Increase font size", function () { const value = visualTextState(visualTextContext()); if (value) setVisualTextValue("size_pt", Math.min(96, Math.round(value.size + 1))); }));
      dom.visualFmtButtons = {};
      for (const spec of [["bold", "Bold"], ["italic", "Italic"], ["underline", "Underline"]]) {
        const button = iconBtn(spec[0], spec[1], (function (key) { return function () { const value = visualTextState(visualTextContext()); if (value) setVisualTextValue(key, !value[key]); }; })(spec[0]));
        dom.visualFmtButtons[spec[0]] = button;
        fontTools.appendChild(button);
      }
      dom.visualColorBtn = el("button", { type: "button", class: "fmde-btn fmde-tool-color", html: iconSvg("color") + '<i class="fmde-tool-color-line"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_99fb946f648fa8","Text color") ?? "Text color"), "aria-label": "Text color" });
      dom.visualColorBtn.addEventListener("click", function () { const value = visualTextState(visualTextContext()); if (value) showColorPalette(dom.visualColorBtn, value.color, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_99fb946f648fa8","Text color") ?? "Text color"), onPick: function (color) { setVisualTextValue("color", color); } }); });
      fontTools.appendChild(dom.visualColorBtn);
      tools.appendChild(fontTools);
    }

    function buildToolbar() {
      closeMenu();
      dom.toolbar.innerHTML = "";
      dom.btnUndo = null; dom.btnRedo = null; dom.zoomLabel = null;
      dom.btnGroup = null; dom.btnUngroup = null; dom.btnFront = null;
      dom.btnForward = null; dom.btnBackward = null; dom.btnBack = null;
      dom.btnAlign = null; dom.btnDuplicate = null; dom.btnDelete = null;
      dom.btnPreview = null; dom.btnDictate = null;
      dom.styleBtn = null; dom.fontBtn = null; dom.docSizeBtn = null;
      dom.fmtButtons = null; dom.colorBtn = null; dom.highlightBtn = null;
      dom.visualTextTools = null; dom.visualFontTools = null;
      dom.visualBackgroundBtn = null; dom.visualFontBtn = null; dom.visualSizeBtn = null;
      dom.visualFmtButtons = null; dom.visualColorBtn = null; dom.visualCornersBtn = null;
      dom.visualStrokeBtn = null; dom.visualBorderColorBtn = null; dom.docBackgroundBtn = null;
      dom.docBorderColorBtn = null; dom.docStrokeBtn = null; dom.docCornersBtn = null;
      const group = function (cls) {
        const g = el("div", { class: "fmde-tb-group" + (cls ? " " + cls : "") });
        dom.toolbar.appendChild(g);
        return g;
      };

      // Segmented mode control (visual | doc | preview) — same command bus and
      // undo stack underneath; fill/inline profiles stay on the visual surface.
      const modes = modesAvailable();
      if (modes.length > 1) {
        const modeGroup = group("fmde-tb-mode");
        const seg = el("div", { class: "fmde-modeseg" });
        const labels = { visual: "Visual", doc: "Doc", preview: "Preview" };
        for (const m of modes) {
          const btn = el("button", {
            type: "button",
            class: "fmde-modebtn" + (state.mode === m ? " active" : ""),
            text: labels[m] || m
          });
          btn.addEventListener("click", (function (target) { return function () { setMode(target); }; })(m));
          seg.appendChild(btn);
        }
        modeGroup.appendChild(seg);
      }

      const addHistoryGroup = function () {
        const history = group(state.mode === "doc" ? "fmde-doc-history" : "");
        dom.btnUndo = iconBtn("undo", "Undo (Ctrl+Z)", function () { performUndo(); });
        dom.btnRedo = iconBtn("redo", "Redo (Ctrl+Shift+Z)", function () { performRedo(); });
        history.appendChild(dom.btnUndo);
        history.appendChild(dom.btnRedo);
      };

      const addZoomGroup = function () {
        const zoomGroup = group("fmde-editor-zoom" + (state.mode === "doc" ? " fmde-doc-zoom" : ""));
        zoomGroup.appendChild(iconBtn("zoomout", "Zoom out", function () { setZoom(state.zoom / 1.2); }));
        dom.zoomLabel = el("button", { type: "button", class: "fmde-btn fmde-zoom-label", text: Math.round(state.zoom * 100) + "%" });
        dom.zoomLabel.addEventListener("click", function () {
          showMenu(dom.zoomLabel, [50, 75, 100, 125, 150, 200].map(function (pct) {
            return { label: pct + "%", checked: Math.round(state.zoom * 100) === pct, onClick: function () { setZoom(pct / 100); } };
          }).concat(["-",
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_b4e9fa5595e7cf","Fit width") ?? "Fit width"), icon: "fit", checked: state.fitMode === "fit-width", onClick: function () { setZoom("fit-width"); } },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cf68d503a9c6b2","Fit page") ?? "Fit page"), icon: "fit", checked: state.fitMode === "fit-page", onClick: function () { setZoom("fit-page"); } }
          ]));
        });
        zoomGroup.appendChild(dom.zoomLabel);
        zoomGroup.appendChild(iconBtn("zoomin", "Zoom in", function () { setZoom(state.zoom * 1.2); }));
        zoomGroup.appendChild(iconBtn("fit", "Fit page", function () { setZoom("fit-page"); }));
      };

      const addProfileGroup = function () {
        const maxProfile = state.policy.max_profile || "designer";
        const canEscalate = can("unlock") && PROFILE_RANK[state.profile] < PROFILE_RANK[maxProfile];
        const canRelock = PROFILE_RANK[state.profile] > PROFILE_RANK[state.baseProfile];
        if (!canEscalate && !canRelock) return;
        const profileGroup = group("fmde-tb-profile");
        if (canEscalate) {
          const unlockBtn = el("button", {
            type: "button", class: "fmde-btn fmde-btn-labeled fmde-btn-unlock",
            html: iconSvg("unlock") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9b9004a80420ab","Unlock design") ?? "Unlock design")}</span>`,
            title: "Switch to " + maxProfile + " editing"
          });
          unlockBtn.addEventListener("click", function () {
            requestUnlock(maxProfile);
          });
          profileGroup.appendChild(unlockBtn);
        } else if (canRelock) {
          const relockBtn = el("button", {
            type: "button", class: "fmde-btn fmde-btn-labeled",
            html: iconSvg("lock") + "<span>Back to " + state.baseProfile + "</span>"
          });
          relockBtn.addEventListener("click", function () { applyProfile(state.baseProfile); });
          profileGroup.appendChild(relockBtn);
        }
      };

      const addVersionHistoryGroup = function () {
        if (!opts.versionsApi && !hasDocumentAction("versions")) return;
        const historyGroup = group("fmde-tb-version");
        const historyBtn = el("button", {
          type: "button",
          class: "fmde-btn fmde-btn-labeled fmde-version-history-btn",
          html: iconSvg("fa-clock-rotate-left") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_3fe33cd11f8a29","History") ?? "History")}</span>`,
          title: (globalThis.PlatformLanguage?.text("doc-editor","m_a86cbfff424ed3","Version history") ?? "Version history"),
          "aria-label": "Version history"
        });
        historyBtn.addEventListener("click", showVersionHistoryDialog);
        historyGroup.appendChild(historyBtn);
      };

      // Host-specific page actions share the editor's right-aligned control
      // bar instead of being duplicated in an application/global title bar.
      // The host owns behavior; this shared toolbar owns placement and chrome.
      const addHostPageActionsGroup = function () {
        const actions = opts.documentActions || {};
        const hasDevice = typeof actions.device === "function";
        const hasPageSettings = typeof actions.pageSettings === "function";
        const hasPublish = typeof actions.publish === "function";
        const hasSiteChrome = typeof actions.siteChromePreview === "function" && typeof actions.getSiteChromePreview === "function";
        if (!hasDevice && !hasPageSettings && !hasPublish && !hasSiteChrome) return;
        const actionGroup = group("fmde-tb-host-actions");
        if (hasPageSettings) {
          const button = el("button", {
            type: "button",
            class: "fmde-btn fmde-web-controls",
            html: iconSvg("fa-globe"),
            title: (globalThis.PlatformLanguage?.text("doc-editor","m_3f117145fd664f","Web page settings") ?? "Web page settings"),
            "aria-label": "Web page settings",
            "data-ed-web-controls": ""
          });
          button.addEventListener("click", function () { invokeDocumentAction("pageSettings", { button: button }); });
          actionGroup.appendChild(button);
        }
        if (hasDevice) {
          const current = typeof actions.getDevice === "function" ? actions.getDevice() : "desktop";
          const deviceSeg = el("div", { class: "fmde-modeseg fmde-device-seg", role: "group", "aria-label": "Preview size" });
          [["mobile", "fa-mobile-alt", "Mobile preview"], ["desktop", "fa-desktop", "Desktop preview"]].forEach(function (spec) {
            const button = el("button", { type: "button", class: "fmde-modebtn" + (current === spec[0] ? " active" : ""), html: iconSvg(spec[1]), title: spec[2], "aria-label": spec[2] });
            button.setAttribute("data-ed-device", spec[0]);
            button.addEventListener("click", function () {
              deviceSeg.querySelectorAll(".fmde-modebtn").forEach(function (item) { item.classList.toggle("active", item === button); });
              invokeDocumentAction("device", { device: spec[0], button: button });
            });
            deviceSeg.appendChild(button);
          });
          actionGroup.appendChild(deviceSeg);
        }
        if (hasSiteChrome) {
          const chromeState = actions.getSiteChromePreview() || {};
          [["header", "fa-window-maximize", "Header"], ["footer", "fa-window-minimize", "Footer"]].forEach(function (spec) {
            const role = spec[0];
            const value = chromeState[role] || {};
            const options = Array.isArray(value.options) ? value.options : [];
            const control = el("div", { class: "fmde-site-chrome-control", role: "group", "aria-label": spec[2] + " preview" });
            control.setAttribute("data-ed-site-chrome", role);
            control.appendChild(el("i", { class: "fas " + spec[1], "aria-hidden": "true" }));
            const select = el("select", { class: "fmde-site-chrome-select", title: spec[2] + " variant", "aria-label": spec[2] + " variant" });
            if (options.length) {
              options.forEach(function (option) {
                const optionEl = el("option", { value: option.id, text: option.title || spec[2] });
                optionEl.selected = option.id === value.pageId;
                select.appendChild(optionEl);
              });
            } else {
              select.appendChild(el("option", { value: "", text: "No " + role }));
              select.disabled = true;
            }
            const eye = el("button", {
              type: "button",
              class: "fmde-btn fmde-site-chrome-eye" + (value.visible !== false ? " active" : ""),
              html: iconSvg(value.visible !== false ? "fa-eye" : "fa-eye-slash"),
              title: (value.visible !== false ? "Hide " : "Show ") + role + " preview",
              "aria-label": (value.visible !== false ? "Hide " : "Show ") + role + " preview",
              "aria-pressed": value.visible !== false ? "true" : "false"
            });
            eye.disabled = !options.length || !value.pageId;
            const syncEye = function (visible) {
              eye.classList.toggle("active", visible);
              eye.innerHTML = iconSvg(visible ? "fa-eye" : "fa-eye-slash");
              eye.title = (visible ? "Hide " : "Show ") + role + " preview";
              eye.setAttribute("aria-label", eye.title);
              eye.setAttribute("aria-pressed", visible ? "true" : "false");
            };
            select.addEventListener("change", function () {
              invokeDocumentAction("siteChromePreview", { role: role, pageId: select.value, visible: eye.classList.contains("active"), select: select }).then(function (updated) {
                if (!updated) return;
                if (updated.pageId) select.value = updated.pageId;
                syncEye(updated.visible !== false);
              });
            });
            eye.addEventListener("click", function () {
              const visible = !eye.classList.contains("active");
              syncEye(visible);
              invokeDocumentAction("siteChromePreview", { role: role, pageId: select.value, visible: visible, button: eye }).then(function (updated) {
                if (!updated) return;
                if (updated.pageId) select.value = updated.pageId;
                syncEye(updated.visible !== false);
              });
            });
            control.appendChild(select);
            control.appendChild(eye);
            actionGroup.appendChild(control);
          });
        }
        if (hasPublish) {
          const publish = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled fmde-host-publish", html: iconSvg("fa-rocket") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_aa817c98b65c06","Publish") ?? "Publish")}</span>`, title: (globalThis.PlatformLanguage?.text("doc-editor","m_aa817c98b65c06","Publish") ?? "Publish"), "aria-label": "Publish", "data-ed-publish": "" });
          publish.disabled = typeof actions.canPublish === "function" ? !actions.canPublish() : false;
          publish.addEventListener("click", function () { invokeDocumentAction("publish", { button: publish }); });
          actionGroup.appendChild(publish);
        }
      };

      const addDictationGroup = function () {
        if (typeof opts.onDictate !== "function") return;
        const dictationGroup = group(state.mode === "doc" ? "fmde-doc-dictation" : "");
        dom.btnDictate = el("button", {
          type: "button",
          class: "fmde-btn fmde-btn-labeled" + (state.dictating ? " active" : ""),
          html: iconSvg("microphone") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_86ab4afbbbb82b","Dictate") ?? "Dictate")}</span>`,
          title: (globalThis.PlatformLanguage?.text("doc-editor","m_870291f01feab4","Dictate into the selected text section") ?? "Dictate into the selected text section"),
          "aria-label": "Dictate into the selected text section"
        });
        dom.btnDictate.disabled = state.dictating;
        dom.btnDictate.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        dom.btnDictate.addEventListener("click", startDictation);
        dictationGroup.appendChild(dom.btnDictate);
      };

      const addPreviewAgentGroup = function () {
        if (!state.sidePanels.some(function (panel) { return String(panel.id) === "agent"; })) return;
        const agentGroup = group("fmde-tb-preview-agent");
        const active = state.activeInspTab === "agent" && !state.inspectorCollapsed;
        const button = el("button", {
          type: "button",
          class: "fmde-btn fmde-btn-labeled fmde-preview-agent-btn" + (active ? " active" : ""),
          html: iconSvg("pencil") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_b8071e017821d8","Agent") ?? "Agent")}</span>`,
          title: (globalThis.PlatformLanguage?.text("doc-editor","m_6d4641df98e619","Edit with Agent while previewing") ?? "Edit with Agent while previewing"),
          "aria-label": "Edit with Agent while previewing",
          "aria-pressed": active ? "true" : "false"
        });
        button.addEventListener("click", function () { openDocumentAgent(""); });
        agentGroup.appendChild(button);
      };

      if (state.mode === "preview") {
        addZoomGroup();
        dom.toolbar.appendChild(el("div", { class: "fmde-tb-spacer" }));
        addPreviewAgentGroup();
        addHostPageActionsGroup();
        addVersionHistoryGroup();
        addProfileGroup();
        updateToolbarState();
        return;
      }

      if (state.mode === "doc") {
        addHistoryGroup();
        buildDocToolbar(group, addZoomGroup);
        addDictationGroup();
        dom.toolbar.appendChild(el("div", { class: "fmde-tb-spacer" }));
        addVersionHistoryGroup();
        addProfileGroup();
        updateToolbarState();
        if (root.requestAnimationFrame) root.requestAnimationFrame(fitDocToolbar);
        return;
      }

      // Visual keeps the same leading mode/history/zoom vocabulary as Doc,
      // then exposes only controls that apply to the selected element.
      addHistoryGroup();
      addZoomGroup();
      buildVisualTextToolbar(group);
      dom.toolbar.appendChild(el("div", { class: "fmde-tb-spacer" }));
      addHostPageActionsGroup();
      addVersionHistoryGroup();
      addProfileGroup();
      updateToolbarState();
    }

    // ---- doc-mode toolbar (word-processor controls) -----------------------------

    function buildDocToolbar(group, addZoomGroup) {
      const holdSelection = function (btn) {
        // Formatting/menu buttons must not steal the projection's caret.
        btn.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        return btn;
      };

      // Google Docs' familiar leading utilities, followed by zoom in the same
      // relative position. Keep FirstMate's useful +/- zoom controls.
      const utilityGroup = group("fmde-doc-utility");
      const printBtn = iconBtn("print", "Print", function () { if (root.print) root.print(); });
      utilityGroup.appendChild(printBtn);
      const spellBtn = iconBtn("spellcheck", "Spelling and grammar", function () {
        state.spellcheck = !state.spellcheck;
        for (const editable of Array.from(dom.stage.querySelectorAll(".fmde-docedit"))) editable.setAttribute("spellcheck", state.spellcheck ? "true" : "false");
        spellBtn.classList.toggle("active", state.spellcheck);
      });
      spellBtn.classList.toggle("active", state.spellcheck);
      utilityGroup.appendChild(spellBtn);
      const paintBtn = iconBtn("paint", state.paintFormat ? "Apply copied formatting" : "Paint format", function () {
        if (state.paintFormat) {
          docProjection.applyFormatting(state.paintFormat);
          state.paintFormat = null;
          paintBtn.classList.remove("active");
          docProjection.hint("Formatting applied");
        } else {
          state.paintFormat = docProjection.captureFormatting();
          if (state.paintFormat) {
            paintBtn.classList.add("active");
            paintBtn.title = (globalThis.PlatformLanguage?.text("doc-editor","m_dd2b704bbc5b41","Apply copied formatting") ?? "Apply copied formatting");
            docProjection.hint("Formatting copied — select text and click Paint format again");
          }
        }
      });
      paintBtn.classList.toggle("active", !!state.paintFormat);
      utilityGroup.appendChild(holdSelection(paintBtn));
      addZoomGroup();

      // Named-style dropdown (FMDocModel.availableStyleRefs + per-item preview).
      const styleGroup = group("fmde-doc-style");
      const styleBtn = el("button", {
        type: "button",
        class: "fmde-btn fmde-btn-labeled fmde-styleselect",
        html: `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_e102d8b8651cc4","Normal text") ?? "Normal text")}</span>` + iconSvg("chevdown"),
        title: (globalThis.PlatformLanguage?.text("doc-editor","m_a0790240ef66f9","Apply a named style to the selected paragraphs") ?? "Apply a named style to the selected paragraphs")
      });
      const showStyleChoices = function (anchor) {
        let refs = [];
        try { refs = M.availableStyleRefs(state.doc, currentTheme()) || []; } catch (err) { refs = []; }
        if (!refs.length) {
          showMenu(anchor, [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_e910b229bcb0c6","No named styles available") ?? "No named styles available"), disabled: true }]);
          return;
        }
        showMenu(anchor, refs.map(function (ref) {
          let styleDef = {};
          try { styleDef = M.resolveStyleRef(ref, state.doc, currentTheme()) || {}; } catch (err) { styleDef = {}; }
          const font = styleDef.font || styleDef;
          const size = font.size_pt ? Math.min(16, Math.max(10, font.size_pt * 0.9)) : 13;
          const css = "font-family:'" + String(font.family || "Inter").replace(/['\\]/g, "") + "', sans-serif;" +
            "font-size:" + size + "px;font-weight:" + (font.weight || 400) + ";" +
            (font.italic ? "font-style:italic;" : "");
          return {
            label: ref,
            labelHtml: '<span style="' + esc(css) + '">' + esc(ref) + "</span>",
            onClick: function () { docProjection.applyStyleRef(ref); }
          };
        }).concat(["-", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f244798cb72c64","Clear named style") ?? "Clear named style"), onClick: function () { docProjection.applyStyleRef(null); } }]));
      };
      styleBtn.addEventListener("click", function () { showStyleChoices(styleBtn); });
      styleGroup.appendChild(holdSelection(styleBtn));
      dom.styleBtn = styleBtn;

      const backgroundGroup = group("fmde-doc-background");
      dom.docBackgroundBtn = makeBackgroundColorButton("doc");
      backgroundGroup.appendChild(holdSelection(dom.docBackgroundBtn));
      dom.docBorderColorBtn = el("button", { type: "button", class: "fmde-btn fmde-border-color fmde-doc-border-color", html: '<i class="fmde-border-color-dot"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_1296214559baff","Section border color") ?? "Section border color"), "aria-label": "Section border color" });
      dom.docBorderColorBtn.addEventListener("click", function () { const section = currentDocSectionNode(); if (!section) return; const stroke = strokeState(section); showColorPalette(dom.docBorderColorBtn, stroke.color, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_1296214559baff","Section border color") ?? "Section border color"), onPick: function (color) { setStroke(section, { color: color }); } }); });
      backgroundGroup.appendChild(holdSelection(dom.docBorderColorBtn));
      dom.docStrokeBtn = iconBtn("stroke", "Section line width", function () { const section = currentDocSectionNode(); if (section) showStrokeMenu(dom.docStrokeBtn, section); });
      backgroundGroup.appendChild(holdSelection(dom.docStrokeBtn));
      dom.docCornersBtn = el("button", { type: "button", class: "fmde-btn", html: '<i class="fmde-corners-icon"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_2c599d19e02c73","Section corners") ?? "Section corners"), "aria-label": "Section corners" });
      dom.docCornersBtn.addEventListener("click", function () { const section = currentDocSectionNode(); if (section) showCornersMenu(dom.docCornersBtn, section); });
      backgroundGroup.appendChild(holdSelection(dom.docCornersBtn));

      // Font family.
      const fontGroup = group("fmde-doc-font");
      const fontBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled fmde-fontselect", html: "<span>" + esc(state.typingFormat.family || "Arial") + "</span>" + iconSvg("chevdown"), title: (globalThis.PlatformLanguage?.text("doc-editor","m_ce1ba13960e5a4","Font") ?? "Font") });
      fontBtn.addEventListener("click", function () {
        showMenu(fontBtn, catalogFonts().map(function (font) {
          return { label: font.label, labelHtml: '<span style="font-family:' + esc(font.value) + '">' + esc(font.label) + "</span>", onClick: function () { state.typingFormat.family = font.value; fontBtn.querySelector("span").textContent = font.label; docProjection.format("fontName", font.value); } };
        }));
      });
      fontGroup.appendChild(holdSelection(fontBtn));
      dom.fontBtn = fontBtn;

      // Font size follows Docs' minus / value / plus arrangement. The current
      // value lives in state.typingFormat (kept in sync with the caret), so
      // +/- always step from what the caret actually shows.
      const sizeGroup = group("fmde-doc-size");
      const currentFontSize = function () { return Math.round(num(state.typingFormat.size_pt, num(state.doc.settings && state.doc.settings.base_font_pt, 11))); };
      const applySize = function (next) { const value = clamp(Number(next) || 11, 6, 96); sizeBtn.textContent = String(value); docProjection.format("fontSize", value); };
      sizeGroup.appendChild(holdSelection(iconBtn("minus", "Decrease font size", function () { applySize(currentFontSize() - 1); })));
      const sizeBtn = el("button", { type: "button", class: "fmde-btn fmde-fontsize", text: String(currentFontSize()), title: (globalThis.PlatformLanguage?.text("doc-editor","m_b412f18545c32b","Font size") ?? "Font size") });
      sizeBtn.addEventListener("click", function () { showMenu(sizeBtn, [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72].map(function (value) { return { label: String(value), checked: value === currentFontSize(), onClick: function () { applySize(value); } }; })); });
      sizeGroup.appendChild(holdSelection(sizeBtn));
      sizeGroup.appendChild(holdSelection(iconBtn("plusplain", "Increase font size", function () { applySize(currentFontSize() + 1); })));
      dom.docSizeBtn = sizeBtn;

      // Run-level toggles.
      const fmtGroup = group("fmde-doc-format");
      const fmtSpecs = [["bold", "Bold (Ctrl+B)", "bold"], ["italic", "Italic (Ctrl+I)", "italic"], ["underline", "Underline (Ctrl+U)", "underline"]];
      dom.fmtButtons = {};
      for (const spec of fmtSpecs) {
        const btn = iconBtn(spec[0], spec[1], (function (command) { return function () { docProjection.format(command); }; })(spec[2]));
        dom.fmtButtons[spec[2]] = btn;
        fmtGroup.appendChild(holdSelection(btn));
      }

      const colorBtn = el("button", { type: "button", class: "fmde-btn fmde-tool-color", html: iconSvg("color") + '<i class="fmde-tool-color-line"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_99fb946f648fa8","Text color") ?? "Text color"), "aria-label": "Text color" });
      const setTextColor = function (value) { state.typingFormat.color = value; colorBtn.style.setProperty("--tool-color", value); docProjection.format("foreColor", value); };
      colorBtn.style.setProperty("--tool-color", state.typingFormat.color);
      colorBtn.addEventListener("click", function () { showColorPalette(colorBtn, state.typingFormat.color, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_99fb946f648fa8","Text color") ?? "Text color"), onPick: setTextColor }); });
      fmtGroup.appendChild(holdSelection(colorBtn));
      dom.colorBtn = colorBtn;
      const highlightBtn = el("button", { type: "button", class: "fmde-btn fmde-tool-color", html: iconSvg("highlight") + '<i class="fmde-tool-color-line"></i>', title: (globalThis.PlatformLanguage?.text("doc-editor","m_83c944a630cef3","Highlight color") ?? "Highlight color"), "aria-label": "Highlight color" });
      const setHighlightColor = function (value) { state.typingFormat.background = value; highlightBtn.style.setProperty("--tool-color", value === "transparent" ? "#fff" : value); docProjection.format("hiliteColor", value); };
      highlightBtn.style.setProperty("--tool-color", state.typingFormat.background === "transparent" ? "#fff" : state.typingFormat.background);
      highlightBtn.addEventListener("click", function () { showColorPalette(highlightBtn, state.typingFormat.background, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_83c944a630cef3","Highlight color") ?? "Highlight color"), allowNone: true, onPick: setHighlightColor }); });
      fmtGroup.appendChild(holdSelection(highlightBtn));
      dom.highlightBtn = highlightBtn;

      const insertGroup = group("fmde-doc-insert");
      const linkBtn = iconBtn("link", "Insert link", function () { showLinkDialog(); });
      insertGroup.appendChild(holdSelection(linkBtn));
      const commentBtn = iconBtn("comment", "Add comment", function () {
        const target = docProjection.annotationTarget();
        if (!target) { docProjection.hint("Click in the document first"); return; }
        state.commentDraft = { ...target, text: "", focusRequested: true };
        renderCommentThreads();
      });
      insertGroup.appendChild(holdSelection(commentBtn));
      const suggestBtn = iconBtn("pencil", "Suggest an edit", function () {
        const target = docProjection.annotationTarget();
        if (!target || !target.quote) { docProjection.hint("Select text to suggest a change"); return; }
        if (/\r|\n/.test(target.quote)) { docProjection.hint("Suggest changes to one paragraph at a time"); return; }
        showSuggestEditDialog(target);
      });
      insertGroup.appendChild(holdSelection(suggestBtn));
      const imageBtn = iconBtn("image", "Add media, video, or widget", function () { showDocInsertMenu(imageBtn); });
      insertGroup.appendChild(holdSelection(imageBtn));

      // Paragraph alignment and spacing.
      const paraGroup = group("fmde-doc-para");
      const alignBtn = el("button", { type: "button", class: "fmde-btn", html: iconSvg("alignleft") + iconSvg("chevdown"), title: (globalThis.PlatformLanguage?.text("doc-editor","m_15b1018206df05","Paragraph alignment") ?? "Paragraph alignment") });
      alignBtn.addEventListener("click", function () {
        const applyAlign = function (value) {
          docProjection.mutateCoveredBlocks("align-text", function (block) { block.align = value; });
        };
        showMenu(alignBtn, [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8acd145b2aace0","Align left") ?? "Align left"), icon: "alignleft", onClick: function () { applyAlign("left"); }, shortcut: "Ctrl+Shift+L" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_dfe2db476967db","Align center") ?? "Align center"), icon: "alignch", onClick: function () { applyAlign("center"); }, shortcut: "Ctrl+Shift+E" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_af78123f1ab541","Align right") ?? "Align right"), icon: "alignright", onClick: function () { applyAlign("right"); }, shortcut: "Ctrl+Shift+R" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a3a5342098f72f","Justify") ?? "Justify"), icon: "alignleft", onClick: function () { applyAlign("justify"); }, shortcut: "Ctrl+Shift+J" }
        ]);
      });
      paraGroup.appendChild(holdSelection(alignBtn));
      const showSpacingChoices = function (anchor) {
        showMenu(anchor, [1, 1.15, 1.5, 2].map(function (value) { return { label: value === 1 ? "Single" : String(value), onClick: function () { docProjection.mutateCoveredBlocks("line-spacing", function (block) { block.line_height = value; }); } }; }).concat(["-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_792c0e04dbcf31","Add space before paragraph") ?? "Add space before paragraph"), onClick: function () { docProjection.mutateCoveredBlocks("space-before", function (block) { block.space_before_pt = num(block.space_before_pt, 0) ? block.space_before_pt : 10; }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_0b018002f5514f","Add space after paragraph") ?? "Add space after paragraph"), onClick: function () { docProjection.mutateCoveredBlocks("space-after", function (block) { block.space_after_pt = num(block.space_after_pt, 0) ? block.space_after_pt : 10; }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_1b92acc9ea5314","Custom spacing…") ?? "Custom spacing…"), onClick: showCustomSpacingDialog }
        ]));
      };
      const spacingBtn = iconBtn("linespacing", "Line and paragraph spacing", function () { showSpacingChoices(spacingBtn); });
      paraGroup.appendChild(holdSelection(spacingBtn));

      const listGroup = group("fmde-doc-list");
      const toggleList = function (style) { docProjection.mutateCoveredBlocks("list", function (block) { const same = block.type === "list_item" && block.list_style === style; block.type = same ? "paragraph" : "list_item"; if (same) delete block.list_style; else block.list_style = style; }); };
      listGroup.appendChild(holdSelection(iconBtn("checkbox", "Checklist", function () { toggleList("check"); })));
      listGroup.appendChild(holdSelection(iconBtn("list", "Bulleted list", function () { toggleList("bullet"); })));
      listGroup.appendChild(holdSelection(iconBtn("numbered", "Numbered list", function () { toggleList("number"); })));
      listGroup.appendChild(holdSelection(iconBtn("outdent", "Decrease indent", function () { docProjection.mutateCoveredBlocks("outdent", function (block) { block.indent = Math.max(0, Number(block.indent || 0) - 1); }); })));
      listGroup.appendChild(holdSelection(iconBtn("indent", "Increase indent", function () { docProjection.mutateCoveredBlocks("indent", function (block) { block.indent = Math.min(8, Number(block.indent || 0) + 1); }); })));
      listGroup.appendChild(holdSelection(iconBtn("clearformat", "Clear formatting", function () { docProjection.format("removeFormat"); docProjection.applyStyleRef(null); })));

      // Product-specific layout commands live behind the right-aligned More
      // menu instead of displacing familiar word-processing controls.
      const advancedGroup = group("fmde-tb-advanced");
      const advancedBtn = iconBtn("more", "More document options", function () {
        const pageNumOn = !!M.getPath(state.doc, "metadata.page_numbers");
        const items = [];
        const hidden = function (toolbarGroup) {
          if (!toolbarGroup) return false;
          return toolbarGroup.classList.contains("fmde-overflowed") || root.getComputedStyle(toolbarGroup).display === "none";
        };
        const section = function (entries) {
          const usable = entries.filter(Boolean);
          if (!usable.length) return;
          if (items.length && items[items.length - 1] !== "-") items.push("-");
          for (const entry of usable) items.push(entry);
        };

        // Familiar commands appear here only when their complete toolbar group
        // has overflowed, keeping the toolbar and More menu mutually exclusive.
        if (hidden(dom.btnUndo && dom.btnUndo.closest(".fmde-tb-group"))) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4004b71744b54e","Undo") ?? "Undo"), icon: "undo", disabled: !engine.canUndo(), onClick: function () { performUndo(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c6c0222a77068a","Redo") ?? "Redo"), icon: "redo", disabled: !engine.canRedo(), onClick: function () { performRedo(); } }
        ]);
        if (hidden(utilityGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_441fd948b74354","Print") ?? "Print"), icon: "print", onClick: function () { printBtn.click(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4fb436421421cc","Spelling and grammar") ?? "Spelling and grammar"), icon: "spellcheck", checked: state.spellcheck, onClick: function () { spellBtn.click(); } },
          { label: state.paintFormat ? "Apply copied formatting" : "Paint format", icon: "paint", checked: !!state.paintFormat, onClick: function () { paintBtn.click(); } }
        ]);
        if (hidden(dom.zoomLabel && dom.zoomLabel.closest(".fmde-tb-group"))) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_acf282d479dddf","Zoom out") ?? "Zoom out"), icon: "minus", onClick: function () { setZoom(state.zoom / 1.2); } },
          { label: Math.round(state.zoom * 100) + "%", onClick: function () { setTimeout(function () { showMenu(advancedBtn, [50, 75, 100, 125, 150, 200].map(function (pct) { return { label: pct + "%", checked: Math.round(state.zoom * 100) === pct, onClick: function () { setZoom(pct / 100); } }; }).concat(["-", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_b4e9fa5595e7cf","Fit width") ?? "Fit width"), icon: "fit", checked: state.fitMode === "fit-width", onClick: function () { setZoom("fit-width"); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cf68d503a9c6b2","Fit page") ?? "Fit page"), icon: "fit", checked: state.fitMode === "fit-page", onClick: function () { setZoom("fit-page"); } }])); }, 0); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a593d968057ce9","Zoom in") ?? "Zoom in"), icon: "plusplain", onClick: function () { setZoom(state.zoom * 1.2); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cf68d503a9c6b2","Fit page") ?? "Fit page"), icon: "fit", checked: state.fitMode === "fit-page", onClick: function () { setZoom("fit-page"); } }
        ]);
        if (hidden(styleGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d06f75e8bb6f9f","Paragraph style…") ?? "Paragraph style…"), onClick: function () { setTimeout(function () { showStyleChoices(advancedBtn); }, 0); } }
        ]);
        if (hidden(fontGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a0c15eef4e654f","Font…") ?? "Font…"), onClick: function () { setTimeout(function () { showMenu(advancedBtn, catalogFonts().map(function (font) { return { label: font.label, labelHtml: '<span style="font-family:' + esc(font.value) + '">' + esc(font.label) + "</span>", onClick: function () { state.typingFormat.family = font.value; fontBtn.querySelector("span").textContent = font.label; docProjection.format("fontName", font.value); } }; })); }, 0); } }
        ]);
        if (hidden(sizeGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_bb696b7e4d12b1","Decrease font size") ?? "Decrease font size"), icon: "minus", onClick: function () { applySize(currentFontSize() - 1); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_b476757a0c4d5c","Font size…") ?? "Font size…"), onClick: function () { setTimeout(function () { showMenu(advancedBtn, [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72].map(function (value) { return { label: String(value), checked: value === currentFontSize(), onClick: function () { applySize(value); } }; })); }, 0); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_462a5556717123","Increase font size") ?? "Increase font size"), icon: "plusplain", onClick: function () { applySize(currentFontSize() + 1); } }
        ]);
        if (hidden(fmtGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4feeaa2c564c4a","Bold") ?? "Bold"), icon: "bold", onClick: function () { docProjection.format("bold"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4ecc62f00b105d","Italic") ?? "Italic"), icon: "italic", onClick: function () { docProjection.format("italic"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_416585cf6011a3","Underline") ?? "Underline"), icon: "underline", onClick: function () { docProjection.format("underline"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d16ba3f3959593","Text color…") ?? "Text color…"), icon: "color", onClick: function () { setTimeout(function () { showColorPalette(advancedBtn, state.typingFormat.color, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_99fb946f648fa8","Text color") ?? "Text color"), onPick: setTextColor }); }, 0); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_6839d924b0fdf7","Highlight color…") ?? "Highlight color…"), icon: "highlight", onClick: function () { setTimeout(function () { showColorPalette(advancedBtn, state.typingFormat.background, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_83c944a630cef3","Highlight color") ?? "Highlight color"), allowNone: true, onPick: setHighlightColor }); }, 0); } }
        ]);
        if (hidden(insertGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_ef1ea584d179aa","Insert link") ?? "Insert link"), icon: "link", onClick: function () { linkBtn.click(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c1f78eaa92eba1","Add comment") ?? "Add comment"), icon: "comment", onClick: function () { commentBtn.click(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8edd9c548c8541","Suggest an edit") ?? "Suggest an edit"), icon: "pencil", onClick: function () { suggestBtn.click(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_761edc8c98182f","Add media, video, or widget…") ?? "Add media, video, or widget…"), icon: "image", onClick: function () { showDocInsertMenu(advancedBtn); } }
        ]);
        if (hidden(paraGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8acd145b2aace0","Align left") ?? "Align left"), icon: "alignleft", onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (block) { block.align = "left"; }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_dfe2db476967db","Align center") ?? "Align center"), icon: "alignch", onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (block) { block.align = "center"; }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_af78123f1ab541","Align right") ?? "Align right"), icon: "alignright", onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (block) { block.align = "right"; }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cf7c40cde69b96","Line and paragraph spacing…") ?? "Line and paragraph spacing…"), icon: "linespacing", onClick: function () { setTimeout(function () { showSpacingChoices(advancedBtn); }, 0); } }
        ]);
        if (hidden(listGroup)) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), icon: "checkbox", onClick: function () { toggleList("check"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_589f56c69d8706","Bulleted list") ?? "Bulleted list"), icon: "list", onClick: function () { toggleList("bullet"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_368070fc078263","Numbered list") ?? "Numbered list"), icon: "numbered", onClick: function () { toggleList("number"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_2ac449cd861fce","Decrease indent") ?? "Decrease indent"), icon: "outdent", onClick: function () { docProjection.mutateCoveredBlocks("outdent", function (block) { block.indent = Math.max(0, Number(block.indent || 0) - 1); }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_129a7615785012","Increase indent") ?? "Increase indent"), icon: "indent", onClick: function () { docProjection.mutateCoveredBlocks("indent", function (block) { block.indent = Math.min(8, Number(block.indent || 0) + 1); }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7be1a0c063bd9d","Clear formatting") ?? "Clear formatting"), icon: "clearformat", onClick: function () { docProjection.format("removeFormat"); docProjection.applyStyleRef(null); } }
        ]);
        if (dom.btnDictate && hidden(dom.btnDictate.closest(".fmde-tb-group"))) section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_86ab4afbbbb82b","Dictate") ?? "Dictate"), icon: "microphone", disabled: state.dictating, onClick: function () { startDictation(); } }
        ]);
        const profileGroup = dom.toolbar.querySelector(".fmde-tb-profile");
        if (hidden(profileGroup)) {
          const maxProfile = state.policy.max_profile || "designer";
          const canEscalate = can("unlock") && PROFILE_RANK[state.profile] < PROFILE_RANK[maxProfile];
          const profileLabel = { designer: "Designer", document: "Document", fill: "Fill", inline: "Inline" }[state.profile] || state.profile;
          section([canEscalate
            ? { label: "Unlock " + maxProfile + " editing", icon: "unlock", onClick: function () { requestUnlock(maxProfile); } }
            : PROFILE_RANK[state.profile] > PROFILE_RANK[state.baseProfile]
              ? { label: "Back to " + state.baseProfile, icon: "lock", onClick: function () { applyProfile(state.baseProfile); } }
              : { label: profileLabel + " profile", disabled: true }]);
        }

        // Product-specific layout commands intentionally live only in More.
        section([
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_9ad6a81582baab","Margins…") ?? "Margins…"), icon: "margins", onClick: function () { showMargins(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_3b321d9a875e5b","Page numbers") ?? "Page numbers"), icon: "pages", checked: pageNumOn, onClick: showPageNumbers }
        ]);
        showMenu(advancedBtn, items);
      });
      const showMargins = function () {
        const chainId = state.doc.chains && state.doc.chains.body ? "body" : docProjection.currentChainId();
        if (!chainId) { showMenu(advancedBtn, [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_380f593526f18c","Margins unavailable") ?? "Margins unavailable"), disabled: true }]); return; }
        const current = num(M.getPath(state.doc, "chains." + chainId + ".page_defaults.margins_pt.top"), 72);
        const preset = function (label, value) {
          return {
            label: label + " (" + value + "pt)",
            checked: current === value,
            onClick: function () {
              // Update both authored page regions and future auto-page bounds.
              const marginBox = { top: value, right: value, bottom: value, left: value };
              const commands = Object.keys(state.doc.chains || {}).map(function (id) {
                return { type: "chain.set_defaults", chain_id: id, defaults: { page_defaults: { margins_pt: marginBox } } };
              });
              const paper = M.paperDimensions(state.doc);
              M.walkNodes(state.doc, function (node) {
                const region = node && node.props && node.props.page_region;
                if (!region) return;
                let frame = null;
                if (region === "body") frame = { ...node.frame, x: value, y: value, w: paper.w_pt - value * 2, h: paper.h_pt - value * 2 };
                else if (region === "header") frame = { ...node.frame, x: value, y: Math.max(12, value / 3), w: paper.w_pt - value * 2, h: Math.max(24, value / 2 - 6) };
                else if (region === "footer") frame = { ...node.frame, x: value, y: paper.h_pt - Math.max(54, value * .75), w: paper.w_pt - value * 2, h: Math.max(24, value / 2 - 6) };
                if (frame) commands.push({ type: "node.set", node_id: node.id, prop: "frame", value: frame });
              });
              runCommands(commands, "margins");
            }
          };
        };
        showMenu(advancedBtn, [preset("Narrow", 36), preset("Normal", 72), preset("Wide", 96)]);
      };
      advancedGroup.appendChild(holdSelection(advancedBtn));
      buildDocumentMenubar();
    }

    // ---- Docs-parity helpers (Tranche A) ---------------------------------------

    /** Headings usable as link/outline targets: heading-typed blocks plus
     *  blocks carrying a Title/Heading named style. */
    function documentHeadings() {
      const out = [];
      M.walkNodes(state.doc, function (node) {
        if (node.type !== "text") return;
        for (const block of (node.props && node.props.blocks) || []) {
          const ref = String(block.style_ref || "");
          if (block.type === "heading" || /^(Title|Subtitle|Heading)/.test(ref)) {
            const text = (block.runs || []).map(function (run) { return String(run.text || ""); }).join("").trim();
            if (text) out.push({ node_id: node.id, block_id: block.id, text: text, style_ref: ref || null, level: block.level || null });
          }
        }
      });
      return out;
    }

    function followInternalLink(href) {
      const raw = String(href || "");
      let blockId = null;
      if (raw.indexOf("#fmdoc-block:") === 0) blockId = raw.slice("#fmdoc-block:".length);
      else if (raw.indexOf("#fmdoc-bookmark:") === 0) {
        const id = raw.slice("#fmdoc-bookmark:".length);
        const bookmark = (M.getPath(state.doc, "metadata.bookmarks") || []).find(function (b) { return b.id === id; });
        blockId = bookmark && bookmark.block_id;
      }
      if (!blockId) { showStatus("That link target no longer exists", true); return; }
      const target = dom.stage.querySelector('[data-block-id="' + blockId.replace(/"/g, '\\"') + '"]');
      if (target) { allowExplicitCanvasScroll(); target.scrollIntoView({ block: "center", behavior: "smooth" }); }
      else showStatus("That link target no longer exists", true);
    }

    /** Docs-style bookmark flags: a small marker at the bookmarked line that
     *  offers Copy link / Remove. Re-rendered after every settled render. */
    function renderBookmarkFlags() {
      for (const flag of Array.from(dom.stage.querySelectorAll(".fmde-bookmark-flag"))) flag.remove();
      if (state.mode !== "doc") return;
      const bookmarks = M.getPath(state.doc, "metadata.bookmarks") || [];
      for (const bookmark of bookmarks) {
        const blockEl = dom.stage.querySelector('[data-block-id="' + String(bookmark.block_id || "").replace(/"/g, '\\"') + '"]');
        const pageEl = blockEl && blockEl.closest(".fmdoc-page");
        if (!blockEl || !pageEl) continue;
        const pageRect = pageEl.getBoundingClientRect();
        const blockRect = blockEl.getBoundingClientRect();
        const scale = state.zoom || 1;
        const flag = el("button", {
          type: "button",
          class: "fmde-bookmark-flag",
          title: (globalThis.PlatformLanguage?.text("doc-editor","m_1d16f40a231860","Bookmark — click for options") ?? "Bookmark — click for options"),
          "aria-label": "Bookmark",
          html: iconSvg("bookmark")
        });
        flag.style.left = Math.max(2, (blockRect.left - pageRect.left) / scale - 18) + "px";
        flag.style.top = ((blockRect.top - pageRect.top) / scale) + "px";
        flag.addEventListener("pointerdown", function (ev) { ev.preventDefault(); ev.stopPropagation(); });
        flag.addEventListener("click", (function (bk) {
          return function (ev) {
            ev.stopPropagation();
            showMenu(flag, [
              { label: (globalThis.PlatformLanguage?.text("doc-editor","m_2de105d5176b60","Copy link") ?? "Copy link"), icon: "link", onClick: function () {
                const url = (root.location ? String(root.location.href).split("#")[0] : "") + "#fmdoc-bookmark:" + bk.id;
                const clipboard = root.navigator && root.navigator.clipboard;
                if (clipboard && clipboard.writeText) clipboard.writeText(url).then(function () { showStatus("Bookmark link copied"); }, function () { showStatus(url, false, 4000); });
                else showStatus(url, false, 4000);
              } },
              { label: (globalThis.PlatformLanguage?.text("doc-editor","m_6d1fcba415fc50","Remove bookmark") ?? "Remove bookmark"), icon: "trash", onClick: function () {
                const list = (M.getPath(state.doc, "metadata.bookmarks") || []).filter(function (item) { return item.id !== bk.id; });
                runCommands([{ type: "doc.set", prop: "metadata.bookmarks", value: list }], "bookmark:remove");
                showStatus("Bookmark removed");
              } }
            ]);
          };
        })(bookmark));
        pageEl.appendChild(flag);
      }
    }

    /** Word count while typing (Tools toggle): persistent chip that opens the
     *  full dialog on click, refreshed on every applied command batch. */
    function updateWordCountChip() {
      if (!state.wordCountLive || state.mode !== "doc") {
        if (dom.wordCountChip) { dom.wordCountChip.remove(); dom.wordCountChip = null; }
        return;
      }
      if (!dom.wordCountChip) {
        dom.wordCountChip = el("button", { type: "button", class: "fmde-wordcount-chip", title: (globalThis.PlatformLanguage?.text("doc-editor","m_d9cce4b2626051","Word count") ?? "Word count") });
        dom.wordCountChip.addEventListener("click", showWordCount);
        dom.root.appendChild(dom.wordCountChip);
      }
      const stats = documentTextStats();
      dom.wordCountChip.textContent = stats.words.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.()) + (stats.words === 1 ? " word" : " words");
    }

    // ---- doc-mode image handling ----------------------------------------------

    function clearDocImageSelection() {
      state.imageFocus = null;
      if (dom.imageOverlay) { dom.imageOverlay.remove(); dom.imageOverlay = null; }
    }

    function docImageElement(nodeId) {
      return dom.stage.querySelector('[data-node-type="image"][data-node-id="' + String(nodeId).replace(/"/g, '\\"') + '"], [data-node-type="image"][data-node-id="' + String(nodeId).replace(/"/g, '\\"') + '::part0"]');
    }

    /** The text block an image should float against: the first block of the
     *  nearest text sibling in its chain frame. */
    function nearestFlowBlockId(nodeId) {
      const info = state.nodeIndex.get(nodeId);
      if (!info || !info.parentId) return null;
      const parent = M.findNode(state.doc, info.parentId);
      const siblings = (parent && parent.node.children) || [];
      for (let i = info.index - 1; i >= 0; i -= 1) {
        if (siblings[i] && siblings[i].type === "text") {
          const blocks = (siblings[i].props && siblings[i].props.blocks) || [];
          if (blocks.length) return blocks[blocks.length - 1].id;
        }
      }
      for (let i = info.index + 1; i < siblings.length; i += 1) {
        if (siblings[i] && siblings[i].type === "text") {
          const blocks = (siblings[i].props && siblings[i].props.blocks) || [];
          if (blocks.length) return blocks[0].id;
        }
      }
      return null;
    }

    function setDocImageWrap(mode) {
      const nodeId = state.imageFocus;
      if (!nodeId) return;
      const found = M.findNode(state.doc, nodeId);
      if (!found) return;
      let anchor = "flow";
      if (mode === "left" || mode === "right") {
        const blockId = nearestFlowBlockId(nodeId);
        if (!blockId) { showStatus("Add some text next to the image to wrap around", true); return; }
        anchor = { to_block: blockId, wrap: mode };
      }
      runCommands([{ type: "node.set", node_id: nodeId, prop: "anchor", value: anchor }], "image:wrap");
    }

    function selectDocImage(imgEl) {
      const nodeId = rawNodeId(imgEl.getAttribute("data-node-id") || "");
      if (!nodeId) return;
      setSelection([], { keepInspector: true });
      state.imageFocus = nodeId;
      if (!imgEl.hasAttribute("tabindex")) imgEl.setAttribute("tabindex", "-1");
      if (!imgEl._fmdeDocCropBound) {
        imgEl._fmdeDocCropBound = true;
        imgEl.addEventListener("dblclick", function (event) { startDocCropFromElement(imgEl, event); });
      }
      try { imgEl.focus({ preventScroll: true }); } catch (err) { imgEl.focus(); }
      if (!dom.imageOverlay) {
        dom.imageOverlay = el("div", { class: "fmde-img-overlay" });
        const chip = el("div", { class: "fmde-img-chip", role: "toolbar", "aria-label": "Image options" });
        const chipButton = function (label, onClick, title) {
          const btn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", text: label, title: title || label });
          btn.addEventListener("pointerdown", function (ev) { ev.preventDefault(); ev.stopPropagation(); });
          btn.addEventListener("click", onClick);
          return btn;
        };
        chip.appendChild(chipButton("In line", function () { setDocImageWrap("inline"); }, "Image on its own line"));
        chip.appendChild(chipButton("Wrap left", function () { setDocImageWrap("left"); }, "Float left, text wraps right"));
        chip.appendChild(chipButton("Wrap right", function () { setDocImageWrap("right"); }, "Float right, text wraps left"));
        if (opts.media && typeof opts.media.pick === "function") {
          chip.appendChild(chipButton("Replace", function () {
            Promise.resolve(opts.media.pick({ accept: "image/*", mediaKind: "media" })).then(function (ref) {
              if (ref && state.imageFocus) runCommands([{ type: "node.set", node_id: state.imageFocus, prop: "props.media", value: ref }], "image:replace");
            }).catch(function () { /* cancelled */ });
          }));
        }
        chip.appendChild(chipButton("Delete", function () {
          const target = state.imageFocus;
          clearDocImageSelection();
          if (target) runCommands([{ type: "node.remove", node_id: target }], "image:delete");
        }));
        dom.imageOverlay.appendChild(chip);
        const handle = el("div", { class: "fmde-img-handle", title: (globalThis.PlatformLanguage?.text("doc-editor","m_262ffc4610efbc","Drag to resize") ?? "Drag to resize") });
        handle.addEventListener("pointerdown", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          try { dom.root.focus({ preventScroll: true }); } catch (err) { dom.root.focus(); }
          const target = state.imageFocus && docImageElement(state.imageFocus);
          if (!target) return;
          const startRect = target.getBoundingClientRect();
          const startY = ev.clientY;
          const move = function (moveEv) {
            const height = Math.max(24, startRect.height + (moveEv.clientY - startY));
            target.style.height = height + "px";
            positionDocImageOverlay();
          };
          const up = function (upEv) {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            const heightPx = Math.max(24, startRect.height + (upEv.clientY - startY));
            const scale = state.zoom || 1;
            const heightPt = Math.round(heightPx / scale * 72 / 96);
            const found = state.imageFocus && M.findNode(state.doc, state.imageFocus);
            if (found) runCommands([{ type: "node.set", node_id: state.imageFocus, prop: "frame", value: { ...found.node.frame, h: heightPt } }], "image:resize");
          };
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        });
        dom.imageOverlay.appendChild(handle);
        dom.root.appendChild(dom.imageOverlay);
      }
      positionDocImageOverlay();
    }

    function positionDocImageOverlay() {
      if (!dom.imageOverlay || !state.imageFocus) return;
      const imgEl = docImageElement(state.imageFocus);
      if (!imgEl) { clearDocImageSelection(); return; }
      const rect = imgEl.getBoundingClientRect();
      const rootRect = dom.root.getBoundingClientRect();
      dom.imageOverlay.style.left = (rect.left - rootRect.left) + "px";
      dom.imageOverlay.style.top = (rect.top - rootRect.top) + "px";
      dom.imageOverlay.style.width = rect.width + "px";
      dom.imageOverlay.style.height = rect.height + "px";
    }

    // ---- doc-mode table editing ------------------------------------------------

    function moveTableCellFocus(fromTarget, delta) {
      const cell = fromTarget.closest("td[data-cell], th[data-cell]");
      const tableEl = cell && cell.closest('[data-node-type="table"]');
      if (!tableEl) return;
      const cells = Array.prototype.slice.call(tableEl.querySelectorAll(".fmde-cell-edit"));
      const index = cells.indexOf(cell);
      const next = cells[index + delta];
      if (!next) return;
      next.focus({ preventScroll: true });
      try {
        const range = document.createRange();
        range.selectNodeContents(next);
        const sel = root.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) { /* focus only */ }
    }

    /** Structural table operations from the floating table chip. */
    function tableAction(action, payload) {
      const focusRef = state.tableFocus;
      if (!focusRef) return;
      const found = M.findNode(state.doc, focusRef.nodeId);
      if (!found || found.node.type !== "table") return;
      const props = M.deepClone(found.node.props || {});
      const rows = Array.isArray(props.rows) ? props.rows : [];
      const columns = Array.isArray(props.columns) ? props.columns : [];
      const r = Math.min(focusRef.row, rows.length - 1);
      const c = Math.max(0, Math.min(focusRef.col, columns.length - 1));
      const blankCell = function () { return { text: "" }; };
      const renormalize = function () {
        const total = columns.reduce(function (sum, col) { return sum + (Number(col.width_frac) || 0); }, 0) || 1;
        for (const col of columns) col.width_frac = Math.round(((Number(col.width_frac) || (1 / columns.length)) / total) * 1000) / 1000;
      };
      if (action === "row-above" || action === "row-below") {
        const at = action === "row-above" ? r : r + 1;
        rows.splice(at, 0, { cells: columns.map(blankCell) });
      } else if (action === "col-left" || action === "col-right") {
        const at = action === "col-left" ? c : c + 1;
        columns.splice(at, 0, { width_frac: 1 / Math.max(1, columns.length) });
        renormalize();
        for (const row of rows) (row.cells || []).splice(at, 0, blankCell());
      } else if (action === "del-row") {
        if (rows.length <= 1) { showStatus("A table needs at least one row", true); return; }
        rows.splice(r, 1);
      } else if (action === "del-col") {
        if (columns.length <= 1) { showStatus("A table needs at least one column", true); return; }
        columns.splice(c, 1);
        renormalize();
        for (const row of rows) (row.cells || []).splice(c, 1);
      } else if (action === "merge-right") {
        const row = rows[r];
        const cell = row && row.cells && row.cells[c];
        const next = row && row.cells && row.cells[c + 1];
        if (!cell || !next) { showStatus("No cell to the right to merge with", true); return; }
        const joined = [String(cell.text || ""), String(next.text || "")].filter(Boolean).join(" ");
        cell.text = joined;
        cell.colspan = (Number(cell.colspan) || 1) + (Number(next.colspan) || 1);
        row.cells.splice(c + 1, 1);
      } else if (action === "unmerge") {
        const row = rows[r];
        const cell = row && row.cells && row.cells[c];
        const span = cell && Number(cell.colspan) || 0;
        if (!cell || span < 2) { showStatus("This cell isn't merged", true); return; }
        delete cell.colspan;
        for (let i = 1; i < span; i += 1) row.cells.splice(c + i, 0, blankCell());
      } else if (action === "cell-fill") {
        const row = rows[r];
        const cell = row && row.cells && row.cells[c];
        if (!cell) return;
        if (payload) cell.fill = payload; else delete cell.fill;
      } else if (action === "delete-table") {
        hideTableChip();
        runCommands([{ type: "node.remove", node_id: focusRef.nodeId }], "table:delete");
        return;
      } else return;
      runCommands([
        { type: "node.set", node_id: focusRef.nodeId, prop: "props.columns", value: columns },
        { type: "node.set", node_id: focusRef.nodeId, prop: "props.rows", value: rows }
      ], "table:" + action);
    }

    function hideTableChip() {
      if (dom.tableChip) { dom.tableChip.remove(); dom.tableChip = null; }
      state.tableFocus = null;
    }

    function showTableChip(cellHit) {
      state.tableFocus = { nodeId: cellHit.nodeId, row: cellHit.row, col: cellHit.col };
      state.activeInspTab = "table";
      if (state.selection.length !== 1 || state.selection[0] !== cellHit.nodeId) setSelection([cellHit.nodeId], { keepInspector: true });
      renderInspector();
      if (!dom.tableChip) {
        dom.tableChip = el("div", { class: "fmde-table-chip", role: "toolbar", "aria-label": "Table options" });
        const chipButton = function (label, action, title) {
          const btn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", text: label, title: title || label });
          btn.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
          btn.addEventListener("click", function () { tableAction(action); });
          return btn;
        };
        dom.tableChip.appendChild(chipButton("+Row", "row-below", "Insert row below"));
        dom.tableChip.appendChild(chipButton("+Row above", "row-above", "Insert row above"));
        dom.tableChip.appendChild(chipButton("+Col", "col-right", "Insert column right"));
        dom.tableChip.appendChild(chipButton("+Col left", "col-left", "Insert column left"));
        dom.tableChip.appendChild(chipButton("−Row", "del-row", "Delete row"));
        dom.tableChip.appendChild(chipButton("−Col", "del-col", "Delete column"));
        dom.tableChip.appendChild(chipButton("Merge →", "merge-right", "Merge with cell to the right"));
        dom.tableChip.appendChild(chipButton("Unmerge", "unmerge", "Split merged cell"));
        const fillBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", text: "Cell color", title: (globalThis.PlatformLanguage?.text("doc-editor","m_68c843ccdf230e","Cell background color") ?? "Cell background color") });
        fillBtn.addEventListener("pointerdown", function (ev) { ev.preventDefault(); });
        fillBtn.addEventListener("click", function () {
          showColorPalette(fillBtn, "#ffffff", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_5143126f9b0ac0","Cell color") ?? "Cell color"), allowNone: true, onPick: function (value) { tableAction("cell-fill", value === "transparent" ? null : value); } });
        });
        dom.tableChip.appendChild(fillBtn);
        dom.tableChip.appendChild(chipButton("Delete table", "delete-table"));
        dom.root.appendChild(dom.tableChip);
      }
      const tableRect = cellHit.tableEl.getBoundingClientRect();
      const rootRect = dom.root.getBoundingClientRect();
      dom.tableChip.style.left = Math.max(8, tableRect.left - rootRect.left) + "px";
      dom.tableChip.style.top = Math.max(8, tableRect.top - rootRect.top - 40) + "px";
    }

    function showTableCellContextMenu(cellHit, clientX, clientY) {
      state.tableFocus = { nodeId: cellHit.nodeId, row: cellHit.row, col: cellHit.col };
      const found = M.findNode(state.doc, cellHit.nodeId);
      const cell = found && found.node && found.node.props && found.node.props.rows && found.node.props.rows[cellHit.row] && found.node.props.rows[cellHit.row].cells[cellHit.col];
      showMenu(null, [
        { heading: (globalThis.PlatformLanguage?.text("doc-editor","m_33e50a81b711d9","Cell") ?? "Cell") },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_3a3bf2355adf29","Insert row above") ?? "Insert row above"), onClick: function () { tableAction("row-above"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_1d8081f1cc6b36","Insert row below") ?? "Insert row below"), onClick: function () { tableAction("row-below"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_57896e5fb7a55b","Insert column left") ?? "Insert column left"), onClick: function () { tableAction("col-left"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7e55219f40407e","Insert column right") ?? "Insert column right"), onClick: function () { tableAction("col-right"); } },
        "-",
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_89ee89b2726355","Merge with cell to the right") ?? "Merge with cell to the right"), disabled: function () { return !found || cellHit.col >= ((found.node.props.columns || []).length - 1); }, onClick: function () { tableAction("merge-right"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f2e7033c2b9238","Unmerge cell") ?? "Unmerge cell"), disabled: function () { return !(cell && Number(cell.colspan) > 1); }, onClick: function () { tableAction("unmerge"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a309ed98aaa89a","Cell background") ?? "Cell background"), onClick: function () {
          const anchor = document.elementFromPoint(clientX, clientY) || dom.root;
          showColorPalette(anchor, (cell && cell.fill) || "#ffffff", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a309ed98aaa89a","Cell background") ?? "Cell background"), allowNone: true, onPick: function (value) { tableAction("cell-fill", value === "transparent" ? null : value); } });
        } },
        "-",
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cfd3b475b91604","Delete row") ?? "Delete row"), onClick: function () { tableAction("del-row"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_2eb64479a2d587","Delete column") ?? "Delete column"), onClick: function () { tableAction("del-col"); } },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_3b720ca91377de","Delete table") ?? "Delete table"), icon: "trash", onClick: function () { tableAction("delete-table"); } }
      ], { point: { x: clientX, y: clientY }, className: "fmde-table-context" });
    }

    // Column resize: drag near a cell's right border adjusts width_frac pairs.
    function bindTableResize() {
      let drag = null;
      const boundaryHit = function (ev) {
        if (state.mode !== "doc") return null;
        const cell = ev.target && ev.target.closest ? ev.target.closest("td[data-cell], th[data-cell]") : null;
        if (!cell) return null;
        const rect = cell.getBoundingClientRect();
        if (Math.abs(ev.clientX - rect.right) > 4) return null;
        const hit = docProjection.tableCellFrom(cell);
        if (!hit) return null;
        const found = M.findNode(state.doc, hit.nodeId);
        const columns = found && found.node.props && found.node.props.columns || [];
        const index = hit.col + ((Number((found && found.node.props.rows[hit.row].cells[hit.col] || {}).colspan) || 1) - 1);
        if (index >= columns.length - 1) return null; // last boundary: keep table width fixed
        return { hit: hit, index: index, columns: columns };
      };
      dom.stage.addEventListener("pointermove", function (ev) {
        if (drag) {
          const dx = (ev.clientX - drag.startX) / (drag.tableRect.width || 1);
          const left = Math.max(0.05, Math.min(drag.pair - 0.05, drag.leftStart + dx * drag.total));
          drag.preview[drag.index] = left;
          drag.preview[drag.index + 1] = drag.pair - left;
          const cols = drag.tableEl.querySelectorAll("colgroup col");
          if (cols[drag.index]) cols[drag.index].style.width = (left * 100) + "%";
          if (cols[drag.index + 1]) cols[drag.index + 1].style.width = ((drag.pair - left) * 100) + "%";
          ev.preventDefault();
          return;
        }
        const boundary = boundaryHit(ev);
        dom.stage.classList.toggle("fmde-col-resize", !!boundary);
      });
      dom.stage.addEventListener("pointerdown", function (ev) {
        const boundary = boundaryHit(ev);
        if (!boundary) return;
        const tableEl = boundary.hit.tableEl.querySelector("table") || boundary.hit.tableEl;
        const widths = boundary.columns.map(function (col) { return Number(col.width_frac) || (1 / boundary.columns.length); });
        drag = {
          nodeId: boundary.hit.nodeId,
          index: boundary.index,
          startX: ev.clientX,
          tableEl: tableEl,
          tableRect: tableEl.getBoundingClientRect(),
          total: widths.reduce(function (sum, w) { return sum + w; }, 0),
          leftStart: widths[boundary.index],
          pair: widths[boundary.index] + widths[boundary.index + 1],
          preview: widths.slice()
        };
        ev.preventDefault();
        ev.stopPropagation();
      }, true);
      document.addEventListener("pointerup", function () {
        if (!drag) return;
        const found = M.findNode(state.doc, drag.nodeId);
        if (found) {
          const columns = M.deepClone(found.node.props.columns || []);
          columns.forEach(function (col, index) { col.width_frac = Math.round((drag.preview[index] || col.width_frac || 0) * 1000) / 1000; });
          runCommands([{ type: "node.set", node_id: drag.nodeId, prop: "props.columns", value: columns }], "table:resize-col");
        }
        drag = null;
      });
    }

    /** Docs-style document outline: slim workspace overlay listing headings;
     *  click scrolls. It is owned by the body so it starts below both headers. */
    function renderOutlinePanel() {
      if (dom.outlineToggle) {
        const open = state.showOutline && state.mode === "doc";
        dom.outlineToggle.classList.toggle("active", open);
        dom.outlineToggle.setAttribute("aria-expanded", open ? "true" : "false");
        dom.outlineToggle.setAttribute("aria-label", open ? "Hide document outline" : "Show document outline");
        dom.outlineToggle.title = open ? "Hide document outline" : "Show document outline";
        dom.outlineToggle.innerHTML = iconSvg(open ? "chevleft" : "chevright");
      }
      if (!state.showOutline || state.mode !== "doc") {
        if (dom.outlinePanel) { dom.outlinePanel.remove(); dom.outlinePanel = null; }
        return;
      }
      if (!dom.outlinePanel) {
        dom.outlinePanel = el("div", { class: "fmde-outline-panel", role: "navigation", "aria-label": "Document outline" });
        dom.body.appendChild(dom.outlinePanel);
      }
      const headings = documentHeadings();
      const levelOf = function (h) {
        if (/^Heading (\d)/.test(String(h.style_ref))) return Number(RegExp.$1) - 1;
        if (h.style_ref === "Subtitle") return 1;
        if (h.level) return Math.max(0, h.level - 1);
        return 0;
      };
      dom.outlinePanel.innerHTML = `<div class="fmde-outline-head"><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_c465e5aeb79832","Outline") ?? "Outline")}</span><button type="button" class="fmde-btn" data-outline-close title="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_e2d65666df10e5","Close outline") ?? "Close outline")}">` + iconSvg("x") + "</button></div>" +
        (headings.length
          ? headings.map(function (h) { return '<button type="button" class="fmde-outline-item" data-outline-block="' + esc(h.block_id) + '" style="padding-left:' + (10 + levelOf(h) * 14) + 'px">' + esc(h.text.slice(0, 64)) + "</button>"; }).join("")
          : `<div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_a439fb27be304b","Headings you add to the document will appear here.") ?? "Headings you add to the document will appear here.")}</div>`);
      dom.outlinePanel.querySelector("[data-outline-close]").addEventListener("click", function () { state.showOutline = false; renderOutlinePanel(); });
      dom.outlinePanel.addEventListener("click", function (ev) {
        const item = ev.target && ev.target.closest ? ev.target.closest("[data-outline-block]") : null;
        if (!item) return;
        const target = dom.stage.querySelector('[data-block-id="' + item.dataset.outlineBlock.replace(/"/g, '\\"') + '"]');
        if (target) { allowExplicitCanvasScroll(); target.scrollIntoView({ block: "center", behavior: "smooth" }); }
      });
    }

    // ---- version history + compare (opts.versionsApi adapter) ------------------

    function renderWordDiffHtml(wordDiff) {
      return (wordDiff || []).map(function (part) {
        const cls = part.type === "add" ? "fmde-diff-add" : part.type === "del" ? "fmde-diff-del" : "";
        return cls ? '<span class="' + cls + '">' + esc(part.text) + "</span>" : esc(part.text);
      }).join(" ");
    }

    function showVersionHistoryDialog() {
      const api = opts.versionsApi;
      if (!api) { invokeDocumentAction("versions"); return; }
      showEditorDialog("Version history", `<div class="fmde-version-tools"><input data-version-name placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_3036003f9a87e7","Name this version (optional)") ?? "Name this version (optional)")}"><button type="button" class="fmde-btn fmde-btn-labeled" data-version-save>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9c1f4d04461822","Save version now") ?? "Save version now")}</button></div><div class="fmde-version-list" data-version-list><div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_d2da77452877dd","Loading…") ?? "Loading…")}</div></div><div class="fmde-dialog-actions"><button type="button" class="primary" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div>`, function (dialog) {
        const list = dialog.querySelector("[data-version-list]");
        const reload = function () {
          Promise.resolve(api.list()).then(function (result) {
            const rows = (result && result.checkpoints) || result || [];
            list.innerHTML = rows.length ? "" : `<div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_14daba3d4ddb00","No saved versions yet.") ?? "No saved versions yet.")}</div>`;
            for (const row of rows) {
              const item = el("div", { class: "fmde-version-row" });
              const when = new Date(row.created_at);
              item.appendChild(el("div", { class: "fmde-version-meta", html: "<b>" + esc(row.name || (row.reason === "auto" ? "Autosaved version" : "Version")) + "</b><span>" + esc(isNaN(when.getTime()) ? String(row.created_at || "") : when.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.())) + " · " + esc(row.reason || "manual") + "</span>" }));
              const actions = el("div", { class: "fmde-version-actions" });
              const diffBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", text: "View changes" });
              diffBtn.addEventListener("click", function () {
                Promise.resolve(api.diff(row.id, "current")).then(function (payload) {
                  const diff = (payload && payload.diff) || payload || {};
                  const parts = [];
                  for (const changed of diff.changed_blocks || []) parts.push('<div class="fmde-diff-row">' + renderWordDiffHtml(changed.word_diff) + "</div>");
                  for (const added of diff.added_blocks || []) parts.push('<div class="fmde-diff-row"><span class="fmde-diff-add">' + esc(added.text) + "</span></div>");
                  for (const removed of diff.removed_blocks || []) parts.push('<div class="fmde-diff-row"><span class="fmde-diff-del">' + esc(removed.text) + "</span></div>");
                  if (diff.other_changes) parts.push('<div class="fmde-outline-empty">' + esc(String(diff.other_changes)) + " layout/structure change(s) not shown</div>");
                  showEditorDialog("Changes since “" + (row.name || "this version") + "”", '<div class="fmde-diff-body">' + (parts.join("") || `<div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_1c573ea6f2a987","No text changes.") ?? "No text changes.")}</div>`) + `</div><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_3742924668fb10","Close") ?? "Close")}</button></div>`);
                }).catch(function () { showStatus("Could not load the comparison", true); });
              });
              actions.appendChild(diffBtn);
              const restoreBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", text: "Restore" });
              restoreBtn.addEventListener("click", function () {
                Promise.resolve(api.get(row.id)).then(function (payload) {
                  const definition = payload && (payload.checkpoint && payload.checkpoint.definition || payload.definition);
                  if (!definition) { showStatus("That version could not be loaded", true); return; }
                  editorHandle.setDocument(definition);
                  // A marker command routes the restore through the normal
                  // change stream so the host autosaves the restored state.
                  runCommands([{ type: "doc.set", prop: "metadata.restored_at", value: new Date().toISOString() }], "version:restore");
                  showStatus("Version restored — undo history was reset");
                }).catch(function () { showStatus("That version could not be loaded", true); });
              });
              actions.appendChild(restoreBtn);
              item.appendChild(actions);
              list.appendChild(item);
            }
          }).catch(function () { list.innerHTML = `<div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_5728db08fb4ccc","Version history is unavailable here.") ?? "Version history is unavailable here.")}</div>`; });
        };
        dialog.querySelector("[data-version-save]").addEventListener("click", function () {
          const name = dialog.querySelector("[data-version-name]").value;
          Promise.resolve(api.create({ name: name, reason: "manual" })).then(function () {
            dialog.querySelector("[data-version-name]").value = "";
            reload();
            showStatus("Version saved");
          }).catch(function () { showStatus("Could not save a version", true); });
        });
        reload();
      });
    }

    /** Tools ▸ Compare: materialize the diff against a checkpoint as normal
     *  suggested edits (reusing the existing review/accept UI). */
    function showCompareDialog() {
      const api = opts.versionsApi;
      if (!api) { showStatus("Compare needs version history, which is unavailable here", true); return; }
      Promise.resolve(api.list()).then(function (result) {
        const rows = (result && result.checkpoints) || result || [];
        if (!rows.length) { showStatus("No saved versions to compare against yet", true); return; }
        showMenu(dom.menubar.querySelector('[data-menu-name="Tools"]') || dom.menuSearch, rows.slice(0, 12).map(function (row) {
          return { label: (row.name || "Version") + " — " + new Date(row.created_at).toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.()), onClick: function () {
            Promise.resolve(api.diff("current", row.id)).then(function (payload) {
              const diff = (payload && payload.diff) || payload || {};
              const suggestions = M.deepClone(M.getPath(state.doc, "metadata.suggestions") || []);
              let count = 0;
              for (const changed of diff.changed_blocks || []) {
                suggestions.push({
                  id: M.generateId("sug"),
                  node_id: changed.node_id,
                  block_id: changed.block_id,
                  offset: 0,
                  end_offset: String(changed.before_text || "").length,
                  before_text: String(changed.before_text || ""),
                  replacement: String(changed.after_text || ""),
                  author: { id: "compare", name: "Compare: " + (row.name || "saved version"), email: "" },
                  status: "pending",
                  created_at: new Date().toISOString()
                });
                count += 1;
              }
              if (!count) { showStatus("No text differences with that version"); return; }
              runCommands([{ type: "doc.set", prop: "metadata.suggestions", value: suggestions }], "compare:suggest");
              state.commentsVisible = true;
              updateRootClass();
              renderCommentThreads();
              showStatus(count + " difference" + (count === 1 ? "" : "s") + " added as suggested edits");
            }).catch(function () { showStatus("Could not compare versions", true); });
          } };
        }));
      }).catch(function () { showStatus("Version history is unavailable here", true); });
    }

    // ---- realtime collaboration (opts.collab adapter) --------------------------

    function collabActorId() {
      return String((opts.collab && opts.collab.actor && (opts.collab.actor.id || opts.collab.actor.user_id)) || collaborationActor().id || "");
    }

    function renderCollabCursors() {
      for (const cursor of Array.from(dom.stage.querySelectorAll(".fmde-collab-cursor"))) cursor.remove();
      if (state.mode !== "doc" || !state.collabPresence) return;
      const self = collabActorId();
      for (const entry of state.collabPresence) {
        if (!entry || !entry.cursor || !entry.actor || String(entry.actor.id) === self) continue;
        const cursor = entry.cursor;
        if (!cursor.node_id || !cursor.block_id) continue;
        const range = docProjection.domRangeFor(cursor.node_id, cursor.block_id, Number(cursor.offset) || 0, 0);
        if (!range) continue;
        const rect = range.getBoundingClientRect();
        const pageEl = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer).closest(".fmdoc-page");
        if (!pageEl) continue;
        const pageRect = pageEl.getBoundingClientRect();
        const scale = state.zoom || 1;
        const marker = el("div", { class: "fmde-collab-cursor", title: entry.actor.name || "" });
        marker.style.left = ((rect.left - pageRect.left) / scale) + "px";
        marker.style.top = ((rect.top - pageRect.top) / scale) + "px";
        marker.style.height = Math.max(12, rect.height / scale) + "px";
        marker.style.background = entry.color || "#f57c00";
        const tag = el("span", { class: "fmde-collab-cursor-tag", text: (entry.actor.name || "?").split(/\s+/)[0] });
        tag.style.background = entry.color || "#f57c00";
        marker.appendChild(tag);
        pageEl.appendChild(marker);
      }
    }

    function applyRemoteCommands(commands) {
      if (!Array.isArray(commands) || !commands.length) return;
      docProjection.commitNow("collab-remote");
      state.collabApplying = true;
      try {
        engine.apply(commands, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7eefb16381796c","remote:collab") ?? "remote:collab") });
      } finally {
        state.collabApplying = false;
      }
    }

    function pushCollabCommands(commands) {
      const session = state.collabSession;
      if (!session || !commands.length) return;
      state.collabQueue = (state.collabQueue || []).concat(commands);
      if (state.collabPushing) return;
      state.collabPushing = true;
      const flush = function () {
        const batch = state.collabQueue || [];
        state.collabQueue = [];
        if (!batch.length) { state.collabPushing = false; return; }
        Promise.resolve(session.transport.send(session.revision, batch)).then(function (result) {
          if (!result) { state.collabPushing = false; return; }
          if (result.stale) {
            for (const missed of result.missed || []) {
              if (String(missed.actor_id) !== collabActorId()) applyRemoteCommands(missed.commands);
              session.revision = missed.revision;
            }
            session.revision = Math.max(session.revision, Number(result.revision) || session.revision);
            // retry once with the replayed base
            return Promise.resolve(session.transport.send(session.revision, batch)).then(function (retry) {
              if (retry && retry.revision) session.revision = retry.revision;
              flush();
            });
          }
          if (result.revision) session.revision = result.revision;
          flush();
        }).catch(function () { state.collabPushing = false; });
      };
      flush();
    }

    function connectCollab() {
      const config = opts.collab;
      if (!config || !config.connect) return;
      const transport = config.connect({
        onHello: function (payload) {
          if (!payload) return;
          state.collabSession = { transport: transport, revision: Number(payload.revision) || 0 };
          state.collabPresence = payload.presence || [];
          renderCollabCursors();
        },
        onPresence: function (payload) {
          state.collabPresence = (payload && payload.presence) || [];
          renderCollabCursors();
        },
        onCommands: function (payload) {
          if (!payload) return;
          if (state.collabSession) state.collabSession.revision = Number(payload.revision) || state.collabSession.revision;
          if (payload.actor && String(payload.actor.id) === collabActorId()) return; // own echo
          applyRemoteCommands(payload.commands);
        },
        onError: function () { /* EventSource retries itself */ }
      });
      if (!state.collabSession) state.collabSession = { transport: transport, revision: 0 };
      else state.collabSession.transport = transport;
    }

    function sendCollabPresence() {
      const session = state.collabSession;
      if (!session || !session.transport.presence) return;
      const caret = docProjection.caretTarget();
      if (!caret) return;
      session.transport.presence({ cursor: { node_id: caret.node_id, block_id: caret.block_id, offset: caret.offset } });
    }

    // ---- language engine (FMDocLanguage): suggestions panel + autocorrect ------

    function languageLib() {
      if (opts.language && typeof opts.language.checkSpelling === "function") return opts.language;
      return root.FMDocLanguage && typeof root.FMDocLanguage.checkSpelling === "function" ? root.FMDocLanguage : null;
    }

    let languagePromise = null;
    function ensureLanguage() {
      const lib = languageLib();
      if (!lib) return Promise.resolve(null);
      if (!languagePromise) {
        languagePromise = Promise.resolve(typeof lib.init === "function" ? lib.init({ customWords: opts.customWords || [], onAddWord: opts.onAddWord }) : null)
          .then(function () { state.languageReady = true; return lib; }, function () { return null; });
      }
      return languagePromise;
    }

    function documentTextTargets() {
      const targets = [];
      M.walkNodes(state.doc, function (node) {
        if (node.type !== "text") return;
        for (const block of (node.props && node.props.blocks) || []) {
          const text = (block.runs || []).map(function (run) { return String(run.text || ""); }).join("");
          if (text.trim()) targets.push({ node_id: node.id, block_id: block.id, text: text });
        }
      });
      return targets;
    }

    function refreshLanguageHighlights(issues) {
      if (!(root.CSS && root.CSS.highlights && root.Highlight)) return;
      root.CSS.highlights.delete("fmde-spell");
      root.CSS.highlights.delete("fmde-grammar");
      if (!issues || !issues.length || state.mode !== "doc") return;
      const spelling = [];
      const grammar = [];
      for (const issue of issues) {
        const range = docProjection.domRangeFor(issue.node_id, issue.block_id, issue.start, issue.end - issue.start);
        if (range) (issue.kind === "spelling" ? spelling : grammar).push(range);
      }
      if (spelling.length) root.CSS.highlights.set("fmde-spell", new root.Highlight(...spelling));
      if (grammar.length) root.CSS.highlights.set("fmde-grammar", new root.Highlight(...grammar));
    }

    function closeSpellingPanel() {
      state.languageIssues = null;
      if (root.CSS && root.CSS.highlights) { root.CSS.highlights.delete("fmde-spell"); root.CSS.highlights.delete("fmde-grammar"); }
      if (dom.spellPanel) { dom.spellPanel.remove(); dom.spellPanel = null; }
    }

    function showSpellingPanel() {
      if (dom.spellPanel) { runSpellingScan(); return; }
      dom.spellPanel = el("div", { class: "fmde-spell-panel", role: "dialog", "aria-label": "Spelling and grammar" });
      dom.spellPanel.innerHTML = `<div class="fmde-spell-head"><span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_a55896ccf1a9ae","Spelling & grammar") ?? "Spelling & grammar")}</span><button type="button" class="fmde-btn" data-spell-close title="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_3742924668fb10","Close") ?? "Close")}">` + iconSvg("x") + `</button></div><div class="fmde-spell-list" data-spell-list><div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_4e930690c170d1","Checking…") ?? "Checking…")}</div></div>`;
      dom.spellPanel.querySelector("[data-spell-close]").addEventListener("click", closeSpellingPanel);
      dom.root.appendChild(dom.spellPanel);
      state.languageIgnored = state.languageIgnored || new Set();
      runSpellingScan();
    }

    function runSpellingScan() {
      const list = dom.spellPanel && dom.spellPanel.querySelector("[data-spell-list]");
      if (!list) return;
      ensureLanguage().then(function (lib) {
        if (!dom.spellPanel) return;
        if (!lib) {
          list.innerHTML = `<div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ed82d5cae258b0","The language engine isn't loaded here.") ?? "The language engine isn't loaded here.")}</div>`;
          return;
        }
        const issues = [];
        for (const target of documentTextTargets()) {
          if (issues.length >= 200) break;
          try {
            for (const hit of lib.checkSpelling(target.text) || []) {
              if (state.languageIgnored.has("w:" + hit.word.toLowerCase())) continue;
              issues.push({ kind: "spelling", node_id: target.node_id, block_id: target.block_id, start: hit.start, end: hit.end, label: hit.word, suggestions: hit.suggestions || [] });
            }
            for (const hit of lib.checkGrammar(target.text) || []) {
              issues.push({ kind: "grammar", node_id: target.node_id, block_id: target.block_id, start: hit.start, end: hit.end, label: hit.message, suggestions: hit.replacements || [] });
            }
          } catch (err) { /* engine hiccup: skip block */ }
        }
        state.languageIssues = issues;
        refreshLanguageHighlights(issues);
        list.innerHTML = "";
        if (!issues.length) {
          list.innerHTML = `<div class="fmde-outline-empty">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_6afe7a5077fb26","No issues found — looking good.") ?? "No issues found — looking good.")}</div>`;
          return;
        }
        for (const issue of issues.slice(0, 60)) {
          const row = el("div", { class: "fmde-spell-row fmde-spell-row-" + issue.kind });
          row.appendChild(el("div", { class: "fmde-spell-label", text: issue.label }));
          const actions = el("div", { class: "fmde-spell-actions" });
          for (const suggestion of (issue.suggestions || []).slice(0, 3)) {
            const btn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", text: suggestion });
            btn.addEventListener("click", (function (fix, target) {
              return function () { applyLanguageFix(target, fix); };
            })(suggestion, issue));
            actions.appendChild(btn);
          }
          const ignoreBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled fmde-spell-secondary", text: "Ignore" });
          ignoreBtn.addEventListener("click", (function (target) {
            return function () {
              if (target.kind === "spelling") state.languageIgnored.add("w:" + target.label.toLowerCase());
              state.languageIssues = (state.languageIssues || []).filter(function (item) { return item !== target; });
              runSpellingScan();
            };
          })(issue));
          actions.appendChild(ignoreBtn);
          if (issue.kind === "spelling") {
            const addBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled fmde-spell-secondary", text: "Add to dictionary" });
            addBtn.addEventListener("click", (function (target) {
              return function () {
                const lib2 = languageLib();
                if (lib2 && typeof lib2.addToDictionary === "function") lib2.addToDictionary(target.label);
                runSpellingScan();
              };
            })(issue));
            actions.appendChild(addBtn);
          }
          row.appendChild(actions);
          row.addEventListener("click", (function (target) {
            return function () {
              const range = docProjection.domRangeFor(target.node_id, target.block_id, target.start, target.end - target.start);
              const elx = range && (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer);
              if (elx && elx.scrollIntoView) { allowExplicitCanvasScroll(); elx.scrollIntoView({ block: "center", behavior: "smooth" }); }
            };
          })(issue));
          list.appendChild(row);
        }
      });
    }

    function applyLanguageFix(issue, replacement) {
      const found = M.findNode(state.doc, issue.node_id);
      if (!found) return;
      const blocks = M.deepClone((found.node.props && found.node.props.blocks) || []);
      const block = blocks.find(function (item) { return item.id === issue.block_id; });
      if (!block) return;
      spliceBlockText(block, issue.start, issue.end - issue.start, replacement);
      runCommands([{ type: "text.edit", node_id: issue.node_id, blocks: blocks }], "language-fix");
      runSpellingScan();
    }

    // ---- HTML export -----------------------------------------------------------

    /** File ▸ Download ▸ Web page: render the static surface offscreen and
     *  download a self-contained HTML file (renderer styles embedded). */
    function exportHtmlDownload() {
      const host = el("div");
      host.style.cssText = "position:fixed;left:-12000px;top:0;width:1000px;";
      document.body.appendChild(host);
      let handle = null;
      try {
        handle = renderer.render(host, {
          document: M.deepClone(state.doc),
          theme: currentTheme(),
          themeContext: opts.themeContext || null,
          mode: "static",
          applyThemeMargins: false,
          widgetData: state.widgetData,
          widgetContext: widgetContext,
          mediaUrl: opts.media && typeof opts.media.url === "function" ? function (media, variant) { return opts.media.url(media, variant) || ""; } : null,
          scale: 1
        });
      } catch (err) {
        host.remove();
        showStatus("Could not render the document for export", true);
        return;
      }
      const finish = function () {
        try {
          const styles = document.getElementById("fmdoc-renderer-styles");
          const widgetStyles = document.getElementById("fmdoc-widgets-styles");
          const title = String((state.doc.metadata && (state.doc.metadata.title || state.doc.metadata.document_type)) || "document");
          const htmlText = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + "</title><style>" +
            (styles ? styles.textContent : "") + (widgetStyles ? widgetStyles.textContent : "") +
            "\nbody{margin:0;padding:24px;background:#f1f3f4;display:grid;gap:16px;justify-content:center}</style></head><body>" + host.innerHTML + "</body></html>";
          const blob = new Blob([htmlText], { type: "text/html" });
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(blob);
          anchor.download = title.replace(/[^\w.-]+/g, "_").toLowerCase() + ".html";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(function () { URL.revokeObjectURL(anchor.href); }, 5000);
          showStatus("Downloaded web page (.html)");
        } finally {
          if (handle && typeof handle.destroy === "function") { try { handle.destroy(); } catch (err) { /* gone */ } }
          host.remove();
        }
      };
      if (handle && typeof handle.ready === "function") Promise.resolve(handle.ready()).then(finish, finish);
      else setTimeout(finish, 400);
    }

    // ---- functional ruler ------------------------------------------------------

    function applyMarginDrag(side, valuePt) {
      const rawSize = M.getPath(state.doc, "settings.paper.size") || "letter";
      const dims = M.paperDimensions(state.doc);
      const margins = { top: 72, right: 72, bottom: 72, left: 72, ...(M.getPath(state.doc, "chains.body.page_defaults.margins_pt") || {}) };
      margins[side] = clamp(valuePt, 18, dims.w_pt / 2 - 36);
      applyPageSetup({
        size: typeof rawSize === "string" ? rawSize : "custom",
        orientation: M.getPath(state.doc, "settings.paper.orientation") || "portrait",
        width: dims.w_pt / 72, height: dims.h_pt / 72,
        top: margins.top / 72, right: margins.right / 72, bottom: margins.bottom / 72, left: margins.left / 72
      });
    }

    function renderRulerUI() {
      const want = state.showRuler && state.mode === "doc";
      if (!want) { if (dom.rulerUi) { dom.rulerUi.remove(); dom.rulerUi = null; } return; }
      const pageEl = dom.stage.querySelector(".fmdoc-page");
      if (!pageEl) return;
      if (!dom.rulerUi) {
        dom.rulerUi = el("div", { class: "fmde-ruler-ui", "aria-hidden": "true" });
        const makeHandle = function (cls, title, commit) {
          const handle = el("div", { class: "fmde-ruler-handle " + cls, title: title });
          handle.addEventListener("pointerdown", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const geo = dom.rulerUi._geo;
            if (!geo) return;
            const startX = ev.clientX;
            const startLeft = parseFloat(handle.style.left) || 0;
            const move = function (moveEv) { handle.style.left = (startLeft + moveEv.clientX - startX) + "px"; };
            const up = function (upEv) {
              document.removeEventListener("pointermove", move);
              document.removeEventListener("pointerup", up);
              const finalPx = startLeft + upEv.clientX - startX;
              commit((finalPx - geo.x0) / geo.pxPerPt, geo);
            };
            document.addEventListener("pointermove", move);
            document.addEventListener("pointerup", up);
          });
          dom.rulerUi.appendChild(handle);
          return handle;
        };
        dom.rulerUi._handles = {
          marginLeft: makeHandle("fmde-ruler-margin fmde-ruler-margin-left", "Left margin", function (xPt) { applyMarginDrag("left", xPt); }),
          marginRight: makeHandle("fmde-ruler-margin fmde-ruler-margin-right", "Right margin", function (xPt, geo) { applyMarginDrag("right", geo.paperW - xPt); }),
          firstLine: makeHandle("fmde-ruler-first", "First-line indent", function (xPt, geo) {
            docProjection.mutateCoveredBlocks("ruler-first-line", function (block) {
              const base = geo.margins.left + (Number(block.indent) || 0) * 18;
              const value = Math.round(xPt - base);
              if (value > 0) block.first_line_indent_pt = clamp(value, 1, 216);
              else delete block.first_line_indent_pt;
            });
          }),
          leftIndent: makeHandle("fmde-ruler-indent", "Left indent", function (xPt, geo) {
            const steps = clamp(Math.round((xPt - geo.margins.left) / 18), 0, 8);
            docProjection.mutateCoveredBlocks("ruler-indent", function (block) {
              if (steps) block.indent = steps; else delete block.indent;
            });
          })
        };
        dom.canvas.insertBefore(dom.rulerUi, dom.canvas.firstChild);
      }
      const paper = M.paperDimensions(state.doc);
      const pageRect = pageEl.getBoundingClientRect();
      const rulerRect = dom.rulerUi.getBoundingClientRect();
      const pxPerPt = pageRect.width / Math.max(1, paper.w_pt);
      const x0 = pageRect.left - rulerRect.left;
      const margins = { top: 72, right: 72, bottom: 72, left: 72, ...(M.getPath(state.doc, "chains.body.page_defaults.margins_pt") || {}) };
      // Caret block indents for the triangle markers.
      let indent = 0;
      let firstLine = 0;
      const caret = docProjection.caretTarget();
      if (caret) {
        const found = M.findNode(state.doc, caret.node_id);
        const block = found && ((found.node.props && found.node.props.blocks) || []).find(function (b) { return b.id === caret.block_id; });
        if (block) { indent = Number(block.indent) || 0; firstLine = Number(block.first_line_indent_pt) || 0; }
      }
      dom.rulerUi._geo = { x0: x0, pxPerPt: pxPerPt, margins: margins, paperW: paper.w_pt };
      dom.rulerUi._handles.marginLeft.style.left = (x0 + margins.left * pxPerPt) + "px";
      dom.rulerUi._handles.marginRight.style.left = (x0 + (paper.w_pt - margins.right) * pxPerPt) + "px";
      dom.rulerUi._handles.firstLine.style.left = (x0 + (margins.left + indent * 18 + firstLine) * pxPerPt) + "px";
      dom.rulerUi._handles.leftIndent.style.left = (x0 + (margins.left + indent * 18) * pxPerPt) + "px";
    }

    // ---- header variants + pageless -------------------------------------------

    function regionNode(region) {
      let hit = null;
      M.walkNodes(state.doc, function (node) { if (!hit && node.props && node.props.page_region === region) hit = node; });
      return hit;
    }

    /** Create the *_first / *_even variant frames (empty, base geometry) the
     *  first time their option is enabled — Docs behavior: an empty header you
     *  then type into. */
    function ensureHeaderVariantFrames(suffix) {
      const commands = [];
      for (const page of state.doc.pages || []) {
        for (const kind of ["header", "footer"]) {
          const variant = kind + "_" + suffix;
          if (findPageRegionFrame(page, variant)) continue;
          const base = findPageRegionFrame(page, kind) || regionNode(kind);
          if (!base) continue;
          const frame = M.createNode("frame", {
            name: (suffix === "first" ? "First-page " : "Even-page ") + kind,
            frame: { ...M.deepClone(base.frame), z: (base.frame && base.frame.z || 0) },
            props: { page_region: variant, flow: { direction: "column", gap: 0, padding: [0, 0, 0, 0], align: "stretch", wrap: false }, overflow: "hidden" },
            children: [M.createNode("text", {
              name: variant + " text", anchor: "flow",
              frame: { x: 0, y: 0, w: 0, h: "auto", z: 0, layout: "flow" },
              props: { blocks: [{ id: M.generateId("blk"), type: "paragraph", style_ref: "Normal text", runs: [{ text: "" }] }], valign: "top", auto_fit: false }
            })]
          });
          frame.frame.layout = "flow";
          commands.push({ type: "node.insert", node: frame, page_id: page.id, index: (page.children || []).length });
        }
      }
      return commands;
    }

    function setHeaderOption(key, enabled) {
      const options = { ...(M.getPath(state.doc, "settings.header_options") || {}) };
      options[key] = !!enabled;
      const commands = [{ type: "doc.set", prop: "settings.header_options", value: options }];
      if (enabled) {
        const suffix = key === "different_first" ? "first" : "even";
        for (const cmd of ensureHeaderVariantFrames(suffix)) commands.push(cmd);
      }
      runCommands(commands, "header-options");
    }

    function showHeaderOptionsChip(regionEl) {
      hideHeaderOptionsChip();
      const options = M.getPath(state.doc, "settings.header_options") || {};
      dom.headerChip = el("div", { class: "fmde-header-chip", role: "toolbar", "aria-label": "Header options" });
      const checkboxRow = function (label, key) {
        const row = el("label", { class: "fmde-check-label" });
        const box = el("input", { type: "checkbox" });
        box.checked = !!options[key];
        box.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
        box.addEventListener("change", function () { setHeaderOption(key, box.checked); });
        row.appendChild(box);
        row.appendChild(document.createTextNode(" " + label));
        return row;
      };
      dom.headerChip.appendChild(checkboxRow("Different first page", "different_first"));
      dom.headerChip.appendChild(checkboxRow("Different odd & even", "different_odd_even"));
      const rect = regionEl.getBoundingClientRect();
      const stageRect = dom.stage.getBoundingClientRect();
      dom.headerChip.style.left = Math.max(8, rect.left - stageRect.left) + "px";
      dom.headerChip.style.top = Math.max(8, rect.bottom - stageRect.top + 4) + "px";
      // The stage is the scrolling document coordinate system. Owning the chip
      // here keeps it attached to its header/footer as the canvas scrolls.
      dom.stage.appendChild(dom.headerChip);
    }

    function hideHeaderOptionsChip() {
      if (dom.headerChip) { dom.headerChip.remove(); dom.headerChip = null; }
    }

    /** Docs pageless mode: fluid width, single growing page, no header/footer. */
    function togglePageless() {
      const on = !M.getPath(state.doc, "settings.pageless");
      const body = regionNode("body");
      const header = regionNode("header");
      const footer = regionNode("footer");
      const commands = [
        { type: "doc.set", prop: "settings.pageless", value: on },
        { type: "doc.set", prop: "settings.paper.size", value: on ? "fill" : "letter" }
      ];
      if (body) {
        const frame = M.deepClone(body.frame || {});
        if (on) { commands.push({ type: "node.set", node_id: body.id, prop: "frame", value: { ...frame, h: "auto" } }); }
        else {
          const margins = M.getPath(state.doc, "chains.body.page_defaults.margins_pt") || { top: 72, right: 72, bottom: 72, left: 72 };
          commands.push({ type: "node.set", node_id: body.id, prop: "frame", value: { ...frame, h: Math.max(72, 792 - margins.top - margins.bottom) } });
        }
      }
      for (const region of [header, footer]) {
        if (region) commands.push({ type: "node.set", node_id: region.id, prop: "visible", value: !on });
      }
      runCommands(commands, "pageless");
      showStatus(on ? "Pageless — the document is one continuous surface" : "Back to pages");
    }

    /** Insert a footnote anchored at the caret; the strip entry gets focus
     *  after the render settles so the user can type the note immediately. */
    function insertFootnote() {
      const caret = docProjection.caretTarget();
      if (!caret || !caret.block_id) { showStatus("Click in the document first", true); return; }
      const notes = M.deepClone(M.getPath(state.doc, "metadata.footnotes") || []);
      const id = M.generateId("fn");
      notes.push({ id: id, node_id: caret.node_id, block_id: caret.block_id, offset: caret.offset, text: "" });
      state.pendingFootnoteFocus = id;
      runCommands([{ type: "doc.set", prop: "metadata.footnotes", value: notes }], "footnote:add");
    }

    /** Insert or refresh the generated table of contents (a text node flagged
     *  props.toc_generated, one internally-linked line per heading). */
    function insertTableOfContents() {
      const headings = documentHeadings().filter(function (h) { return h.style_ref !== "Title" && h.style_ref !== "Subtitle"; });
      if (!headings.length) { showStatus("Add headings first — the table of contents is built from them", true); return; }
      const levelOf = function (h) { return /^Heading (\d)/.test(String(h.style_ref)) ? Number(RegExp.$1) - 1 : Math.max(0, (h.level || 1) - 1); };
      const blocks = headings.map(function (h) {
        return { id: M.generateId("blk"), type: "paragraph", indent: Math.min(8, levelOf(h)), runs: [{ text: h.text, link: "#fmdoc-block:" + h.block_id }] };
      });
      let tocNode = null;
      M.walkNodes(state.doc, function (node) { if (!tocNode && node.type === "text" && node.props && node.props.toc_generated) tocNode = node; });
      if (tocNode) {
        runCommands([{ type: "text.edit", node_id: tocNode.id, blocks: blocks }], "toc:update");
        showStatus("Table of contents updated");
        return;
      }
      const node = M.createNode("text", {
        name: "Table of contents", anchor: "flow",
        frame: { x: 0, y: 0, w: 0, h: "auto", z: 0, layout: "flow" },
        props: { toc_generated: true, blocks: blocks, valign: "top", auto_fit: false }
      });
      docProjection.insertFlowNode(node);
      showStatus("Table of contents inserted — run Insert ▸ Table of contents again to refresh it");
    }

    function showBordersShadingDialog() {
      let current = {};
      const caret = docProjection.caretTarget();
      if (caret) {
        const found = M.findNode(state.doc, caret.node_id);
        const block = found && ((found.node.props && found.node.props.blocks) || []).find(function (b) { return b.id === caret.block_id; });
        if (block) current = block;
      }
      const border = current.border || {};
      const sides = border.sides || { top: true, bottom: true, left: true, right: true };
      showEditorDialog("Borders & shading", '<div class="fmde-dialog-grid">' +
        `<div class="fmde-border-sides"><label class="fmde-check-label"><input type="checkbox" data-bs-top>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8de9b34523a9a7"," Top") ?? " Top")}</label><label class="fmde-check-label"><input type="checkbox" data-bs-bottom>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_c1fe1adbd0c534"," Bottom") ?? " Bottom")}</label><label class="fmde-check-label"><input type="checkbox" data-bs-left>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_0da18624bf3204"," Left") ?? " Left")}</label><label class="fmde-check-label"><input type="checkbox" data-bs-right>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_7305c0133dad10"," Right") ?? " Right")}</label></div>` +
        `<label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_d59821adea404c","Border width (pt)") ?? "Border width (pt)")}<input type="number" min="0" max="6" step="0.25" data-bs-width></label>` +
        `<label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_7899f3ce77edbc","Border color") ?? "Border color")}<input type="color" data-bs-color></label>` +
        `<label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_e9440ca6ce0675","Paragraph shading") ?? "Paragraph shading")}<input type="color" data-bs-shading></label>` +
        `<label class="fmde-check-label"><input type="checkbox" data-bs-noshading>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_5bff5268dce981"," No shading") ?? " No shading")}</label>` +
        `</div><div class="fmde-dialog-actions"><button type="button" data-bs-remove>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_60d31e040797af","Remove all") ?? "Remove all")}</button><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="primary" data-bs-apply>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9417f96a1856fa","Apply") ?? "Apply")}</button></div>`, function (dialog, close) {
        dialog.querySelector("[data-bs-top]").checked = sides.top !== false;
        dialog.querySelector("[data-bs-bottom]").checked = sides.bottom !== false;
        dialog.querySelector("[data-bs-left]").checked = sides.left !== false;
        dialog.querySelector("[data-bs-right]").checked = sides.right !== false;
        dialog.querySelector("[data-bs-width]").value = num(border.width_pt, 0);
        dialog.querySelector("[data-bs-color]").value = /^#[0-9a-f]{6}$/i.test(String(border.color)) ? border.color : "#000000";
        dialog.querySelector("[data-bs-shading]").value = /^#[0-9a-f]{6}$/i.test(String(current.shading)) ? current.shading : "#fff2cc";
        dialog.querySelector("[data-bs-noshading]").checked = !current.shading;
        dialog.querySelector("[data-bs-apply]").addEventListener("click", function () {
          const width = Math.max(0, Number(dialog.querySelector("[data-bs-width]").value) || 0);
          const config = width > 0 ? {
            width_pt: width,
            color: dialog.querySelector("[data-bs-color]").value,
            sides: { top: dialog.querySelector("[data-bs-top]").checked, bottom: dialog.querySelector("[data-bs-bottom]").checked, left: dialog.querySelector("[data-bs-left]").checked, right: dialog.querySelector("[data-bs-right]").checked }
          } : null;
          const shading = dialog.querySelector("[data-bs-noshading]").checked ? null : dialog.querySelector("[data-bs-shading]").value;
          docProjection.mutateCoveredBlocks("borders-shading", function (block) {
            if (config) block.border = M.deepClone(config); else delete block.border;
            if (shading) block.shading = shading; else delete block.shading;
          });
          close();
        });
        dialog.querySelector("[data-bs-remove]").addEventListener("click", function () {
          docProjection.mutateCoveredBlocks("borders-shading", function (block) { delete block.border; delete block.shading; });
          close();
        });
      });
    }

    function showCustomSpacingDialog() {
      // Prefill from the caret's block so the dialog reads as "current values".
      let current = {};
      const caret = docProjection.caretTarget();
      if (caret) {
        const found = M.findNode(state.doc, caret.node_id);
        const block = found && ((found.node.props && found.node.props.blocks) || []).find(function (b) { return b.id === caret.block_id; });
        if (block) current = block;
      }
      showEditorDialog("Custom spacing", `<div class="fmde-dialog-grid"><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_e01866f596bc6b","Line spacing") ?? "Line spacing")}<input type="number" min="0.5" max="4" step="0.05" data-spacing-line></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_6eec932389dec3","Space before paragraph (pt)") ?? "Space before paragraph (pt)")}<input type="number" min="0" max="144" step="1" data-spacing-before></label><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_be19f2dc73c114","Space after paragraph (pt)") ?? "Space after paragraph (pt)")}<input type="number" min="0" max="144" step="1" data-spacing-after></label></div><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="primary" data-spacing-apply>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9417f96a1856fa","Apply") ?? "Apply")}</button></div>`, function (dialog, close) {
        dialog.querySelector("[data-spacing-line]").value = num(current.line_height, 1.15);
        dialog.querySelector("[data-spacing-before]").value = num(current.space_before_pt, 0);
        dialog.querySelector("[data-spacing-after]").value = num(current.space_after_pt, 0);
        dialog.querySelector("[data-spacing-apply]").addEventListener("click", function () {
          const line = clamp(Number(dialog.querySelector("[data-spacing-line]").value) || 1.15, 0.5, 4);
          const before = Math.max(0, Number(dialog.querySelector("[data-spacing-before]").value) || 0);
          const after = Math.max(0, Number(dialog.querySelector("[data-spacing-after]").value) || 0);
          docProjection.mutateCoveredBlocks("custom-spacing", function (block) {
            block.line_height = line;
            if (before) block.space_before_pt = before; else delete block.space_before_pt;
            if (after) block.space_after_pt = after; else delete block.space_after_pt;
          });
          close();
        });
      });
    }

    // Curated character set for the browser dialog: name + glyph, searchable.
    const SPECIAL_CHARACTERS = [
      ["Punctuation", [["—","em dash"],["–","en dash"],["…","ellipsis"],["§","section sign"],["¶","pilcrow"],["†","dagger"],["‡","double dagger"],["•","bullet"],["·","middle dot"],["«","left angle quote"],["»","right angle quote"],["‘","left single quote"],["’","right single quote"],["“","left double quote"],["”","right double quote"],["¡","inverted exclamation"],["¿","inverted question"],["′","prime"],["″","double prime"],["‰","per mille"]]],
      ["Currency", [["$","dollar"],["€","euro"],["£","pound"],["¥","yen"],["¢","cent"],["₹","rupee"],["₩","won"],["₽","ruble"],["₪","shekel"],["₫","dong"],["₴","hryvnia"],["₦","naira"],["฿","baht"],["₱","peso"]]],
      ["Math", [["±","plus minus"],["×","multiplication"],["÷","division"],["≈","approximately equal"],["≠","not equal"],["≤","less than or equal"],["≥","greater than or equal"],["∞","infinity"],["√","square root"],["∑","summation"],["∏","product"],["∫","integral"],["∂","partial differential"],["Δ","delta increment"],["π","pi"],["µ","micro"],["°","degree"],["∅","empty set"],["∈","element of"],["∩","intersection"],["∪","union"],["¬","not sign"],["⅓","one third"],["⅔","two thirds"],["¼","one quarter"],["½","one half"],["¾","three quarters"],["⅛","one eighth"],["¹","superscript one"],["²","superscript two"],["³","superscript three"]]],
      ["Arrows", [["←","left arrow"],["→","right arrow"],["↑","up arrow"],["↓","down arrow"],["↔","left right arrow"],["⇐","double left arrow"],["⇒","double right arrow"],["⇔","double left right arrow"],["↵","carriage return"],["⤴","up right arrow"],["⤵","down right arrow"]]],
      ["Symbols", [["©","copyright"],["®","registered"],["™","trademark"],["✓","check mark"],["✗","ballot x"],["★","black star"],["☆","white star"],["♥","heart"],["♦","diamond"],["♣","club"],["♠","spade"],["☐","ballot box"],["☑","ballot box checked"],["☒","ballot box x"],["⚠","warning"],["☎","telephone"],["✉","envelope"],["⚡","lightning"],["♻","recycling"],["⌘","command key"],["⌥","option key"],["⇧","shift key"],["⏎","return key"],["№","numero"],["℮","estimated"],["℗","sound recording copyright"]]],
      ["Latin accents", [["á","a acute"],["à","a grave"],["â","a circumflex"],["ä","a umlaut"],["ã","a tilde"],["å","a ring"],["æ","ae ligature"],["ç","c cedilla"],["é","e acute"],["è","e grave"],["ê","e circumflex"],["ë","e umlaut"],["í","i acute"],["ì","i grave"],["î","i circumflex"],["ï","i umlaut"],["ñ","n tilde"],["ó","o acute"],["ò","o grave"],["ô","o circumflex"],["ö","o umlaut"],["õ","o tilde"],["ø","o slash"],["œ","oe ligature"],["ú","u acute"],["ù","u grave"],["û","u circumflex"],["ü","u umlaut"],["ý","y acute"],["ÿ","y umlaut"],["ß","sharp s"]]],
      ["Greek", [["α","alpha"],["β","beta"],["γ","gamma"],["δ","delta"],["ε","epsilon"],["ζ","zeta"],["η","eta"],["θ","theta"],["λ","lambda"],["ν","nu"],["ξ","xi"],["ρ","rho"],["σ","sigma"],["τ","tau"],["φ","phi"],["χ","chi"],["ψ","psi"],["ω","omega"],["Γ","capital gamma"],["Θ","capital theta"],["Λ","capital lambda"],["Ξ","capital xi"],["Π","capital pi"],["Σ","capital sigma"],["Φ","capital phi"],["Ψ","capital psi"],["Ω","capital omega"]]]
    ];

    function showSpecialCharacters() {
      const caretAtOpen = docProjection.caretTarget();
      const sections = SPECIAL_CHARACTERS.map(function (group) {
        return '<section class="fmde-specialchar-section" data-sc-section><h3>' + esc(group[0]) + '</h3><div class="fmde-specialchar-grid">' + group[1].map(function (entry) {
          return '<button type="button" class="fmde-specialchar" data-sc-char="' + esc(entry[0]) + '" data-sc-name="' + esc(entry[1].toLowerCase()) + '" title="' + esc(entry[1]) + '">' + esc(entry[0]) + '</button>';
        }).join("") + '</div></section>';
      }).join("");
      showEditorDialog("Special characters", `<input class="fmde-shortcut-search" data-sc-search placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_babc8b87dc8837","Search by name (e.g. arrow, euro, check)") ?? "Search by name (e.g. arrow, euro, check)")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_45699ee8a161b1","Search special characters") ?? "Search special characters")}"><div class="fmde-specialchar-list">` + sections + `</div><div class="fmde-dialog-actions"><button type="button" class="primary" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div>`, function (dialog) {
        const search = dialog.querySelector("[data-sc-search]");
        search.addEventListener("input", function () {
          const query = search.value.trim().toLowerCase();
          dialog.querySelectorAll("[data-sc-char]").forEach(function (button) { button.hidden = !!query && button.dataset.scName.indexOf(query) === -1; });
          dialog.querySelectorAll("[data-sc-section]").forEach(function (section) { section.hidden = !section.querySelector("[data-sc-char]:not([hidden])"); });
        });
        dialog.addEventListener("click", function (ev) {
          const button = ev.target && ev.target.closest ? ev.target.closest("[data-sc-char]") : null;
          if (!button) return;
          // Keep the dialog open (Docs behavior) so several can be inserted;
          // each insert advances the remembered caret past the new character.
          const caret = docProjection.caretTarget() || caretAtOpen;
          docProjection.insertText(button.dataset.scChar, caret);
        });
        search.focus();
      });
    }

    function showSuggestEditDialog(target) {
      showEditorDialog("Suggest an edit", `<p class="fmde-dialog-note">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_22e8aabf845e54","Propose replacement text for:") ?? "Propose replacement text for:")}</p><blockquote class="fmde-suggest-quote">` + esc(target.quote) + `</blockquote><div class="fmde-dialog-grid"><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_15e0cb625dcebb","Replace with") ?? "Replace with")}<textarea rows="3" data-suggest-text></textarea></label></div><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="primary" data-suggest-apply>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_ebfecbd5d432bb","Suggest") ?? "Suggest")}</button></div>`, function (dialog, close) {
        const input = dialog.querySelector("[data-suggest-text]");
        input.value = target.quote;
        const submit = function () {
          const replacement = String(input.value || "");
          close();
          if (replacement === target.quote) return;
          const suggestions = M.deepClone(M.getPath(state.doc, "metadata.suggestions") || []);
          suggestions.push({
            id: M.generateId("sug"),
            node_id: target.node_id,
            block_id: target.block_id,
            chain_id: target.chain_id,
            offset: target.offset,
            end_offset: target.end_offset,
            before_text: target.quote,
            replacement: replacement,
            author: collaborationActor(),
            status: "pending",
            created_at: new Date().toISOString()
          });
          runCommands([{ type: "doc.set", prop: "metadata.suggestions", value: suggestions }], "suggestion:add");
          docProjection.hint("Suggestion added for review");
        };
        dialog.querySelector("[data-suggest-apply]").addEventListener("click", submit);
        input.addEventListener("keydown", function (ev) { if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); submit(); } });
        input.focus();
        input.select();
      });
    }

    function showLinkDialog() {
      // The dialog input steals the document selection, so snapshot the live
      // range first and restore it right before applying the link.
      const sel = root.getSelection ? root.getSelection() : null;
      const savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const headings = documentHeadings();
      const bookmarks = M.getPath(state.doc, "metadata.bookmarks") || [];
      const targets = headings.map(function (h) { return { value: "#fmdoc-block:" + h.block_id, label: (h.style_ref || "Heading") + " — " + h.text.slice(0, 60) }; })
        .concat(bookmarks.map(function (b, index) { return { value: "#fmdoc-bookmark:" + b.id, label: "Bookmark " + (index + 1) }; }));
      const targetsHtml = targets.length
        ? `<label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_f7d34a2e4f2908","Or link to a heading or bookmark") ?? "Or link to a heading or bookmark")}<select data-link-target><option value="">${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9972aefa5fac0b","Choose in this document…") ?? "Choose in this document…")}</option>` + targets.map(function (t) { return '<option value="' + esc(t.value) + '">' + esc(t.label) + "</option>"; }).join("") + "</select></label>"
        : "";
      showEditorDialog("Insert link", `<div class="fmde-dialog-grid"><label>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_f3598d503abe19","Link URL") ?? "Link URL")}<input type="url" data-link-url placeholder="https://"></label>` + targetsHtml + `</div><div class="fmde-dialog-actions"><button type="button" data-dialog-close>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="primary" data-link-apply>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_9417f96a1856fa","Apply") ?? "Apply")}</button></div>`, function (dialog, close) {
        const input = dialog.querySelector("[data-link-url]");
        const targetSelect = dialog.querySelector("[data-link-target]");
        if (targetSelect) targetSelect.addEventListener("change", function () { if (targetSelect.value) input.value = targetSelect.value; });
        dialog.querySelector("[data-link-apply]").addEventListener("click", function () {
          const href = input.value;
          close();
          if (!href) return;
          if (savedRange) {
            const editable = savedRange.startContainer && (savedRange.startContainer.nodeType === 1 ? savedRange.startContainer : savedRange.startContainer.parentElement);
            const part = editable && editable.closest ? editable.closest(".fmde-docedit") : null;
            if (part && part.focus) part.focus({ preventScroll: true });
            const live = root.getSelection();
            live.removeAllRanges();
            live.addRange(savedRange);
          }
          docProjection.format("createLink", href);
        });
        input.focus();
      });
    }

    function flattenMenuCommands(definitions) {
      const out = [];
      for (const group of definitions) {
        for (const item of group.items || []) {
          if (!item || typeof item !== "object" || item.heading) continue;
          const children = typeof item.children === "function" ? item.children() : item.children;
          if (children && children.length) {
            for (const child of children) if (child && typeof child === "object" && child.label && child.onClick) out.push({ label: group.label + " › " + child.label, onClick: child.onClick });
          } else if (item.label && item.onClick && !item.disabled) out.push({ label: group.label + " › " + item.label, onClick: item.onClick });
        }
      }
      return out;
    }

    function showMenuSearch(anchor, definitions) {
      closeMenu();
      const menu = applyEditorBranding(el("div", { class: "fmde-menu fmde-command-menu" }));
      const input = el("input", { class: "fmde-command-search", placeholder: (globalThis.PlatformLanguage?.text("doc-editor","m_bf750c546bd2e3","Search menus") ?? "Search menus"), "aria-label": "Search document menus" });
      const results = el("div", { class: "fmde-command-results" });
      const commands = flattenMenuCommands(definitions);
      const render = function () {
        const query = String(input.value || "").trim().toLowerCase();
        const matches = commands.filter(function (command) { return !query || command.label.toLowerCase().includes(query); }).slice(0, 24);
        results.innerHTML = "";
        for (const command of matches) {
          const row = el("button", { type: "button", class: "fmde-menu-item", html: '<span class="fmde-menu-label">' + esc(command.label) + '</span>' });
          row.addEventListener("click", function () { closeMenu(); command.onClick(); });
          results.appendChild(row);
        }
        if (!matches.length) results.appendChild(el("div", { class: "fmde-menu-heading", text: "No matching commands" }));
      };
      input.addEventListener("input", render);
      menu.appendChild(input); menu.appendChild(results); document.body.appendChild(menu);
      const rect = anchor.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(rect.left, root.innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = rect.bottom + 4 + "px";
      openMenu = menu; openMenus = [menu]; openMenuAnchor = anchor; anchor.classList.add("active");
      render(); input.focus();
      setTimeout(function () { document.addEventListener("pointerdown", onMenuOutside, true); }, 0);
    }

    /** Menu-driven paste. Reads text through the async clipboard API (the
     *  only path allowed outside keyboard shortcuts) and inserts it at the
     *  caret; plain=true is also the "without formatting" behavior since
     *  clipboard.readText() strips styling by definition. */
    function pasteFromClipboard(plain) {
      const clipboard = root.navigator && root.navigator.clipboard;
      if (!clipboard || typeof clipboard.readText !== "function") {
        showStatus("Press Ctrl+V to paste", true);
        return;
      }
      clipboard.readText().then(function (text) {
        if (!text) { showStatus("Clipboard is empty", true); return; }
        docProjection.restoreLastCaret();
        docProjection.insertText(text);
      }).catch(function () {
        showStatus("Press Ctrl+V to paste (clipboard access was blocked)", true);
      });
    }

    function buildDocumentMenubar() {
      if (!dom.menubar) return;
      dom.menubar.innerHTML = "";
      if (state.mode !== "doc") return;
      const clickTool = function (title) { const button = dom.toolbar.querySelector('button[title="' + title.replace(/"/g, '\\"') + '"]'); if (button) button.click(); };
      const comments = function () { state.commentsVisible = !state.commentsVisible; updateRootClass(); renderCommentThreads(); };
      const reviewSuggestions = function () { state.commentsVisible = true; updateRootClass(); renderCommentThreads(); const first = dom.stage.querySelector("[data-suggestion-id]"); if (first) { allowExplicitCanvasScroll(); first.scrollIntoView({ block: "center", behavior: "smooth" }); } else showStatus("No suggested edits to review"); };
      const pageNumbers = showPageNumbers;
      const headerFooter = function (region) { const target = dom.stage.querySelector('[data-page-region="' + region + '"] .fmde-docedit'); if (target) { target.focus(); const block = target.querySelector(".fmdoc-block"); if (block) block.click(); } };
      const insertRule = function () { docProjection.insertFlowNode(M.createNode("shape", { name: "Horizontal line", anchor: "flow", frame: { x: 0, y: 0, w: 0, h: 1, z: 0 }, style: { fill: { type: "solid", color: "#9aa0a6" } }, props: { shape: "rect" } })); };
      const toggleFullscreen = function () { if (document.fullscreenElement) document.exitFullscreen(); else dom.root.requestFullscreen && dom.root.requestFullscreen(); };
      const menuDefinitions = [
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_fa09b3f3085cdc","File") ?? "File"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_96834d2fc9c9a5","New") ?? "New"), icon: "plus", onClick: function () { invokeDocumentAction("new"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c25cc66b28cc9d","Open") ?? "Open"), onClick: function () { invokeDocumentAction("open"); }, shortcut: "Ctrl+O" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_769d461c7b7abf","Make a copy") ?? "Make a copy"), icon: "copy", onClick: function () { invokeDocumentAction("copy"); } }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8cf67173c2dbd0","Share") ?? "Share"), onClick: function () { invokeDocumentAction("share"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_5d2b9327181e33","Email") ?? "Email"), onClick: function () { invokeDocumentAction("email"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_871659bb2df660","Download") ?? "Download"), children: function () { return [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_b173eca04826a1","PDF document (.pdf)") ?? "PDF document (.pdf)"), onClick: function () { invokeDocumentAction("download", { format: "pdf" }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_58bdd51238bc30","Microsoft Word (.doc)") ?? "Microsoft Word (.doc)"), onClick: function () { invokeDocumentAction("download", { format: "doc" }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f23cf21e890282","Web page (.html)") ?? "Web page (.html)"), onClick: exportHtmlDownload }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cea915020d63e8","Plain text (.txt)") ?? "Plain text (.txt)"), onClick: function () { invokeDocumentAction("download", { format: "txt" }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_0c510eaef6b6ff","FirstMate source (.json)") ?? "FirstMate source (.json)"), onClick: function () { invokeDocumentAction("download", { format: "json" }); } }]; }, onClick: showDownloadDialog }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e32e6dab52dcf9","Rename") ?? "Rename"), icon: "pencil", onClick: function () { invokeDocumentAction("rename"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_552d55b4b2e140","Move") ?? "Move"), onClick: function () { invokeDocumentAction("move"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_6561131d114e45","Move to trash") ?? "Move to trash"), icon: "trash", onClick: function () { invokeDocumentAction("trash"); } }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a86cbfff424ed3","Version history") ?? "Version history"), onClick: showVersionHistoryDialog },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4fd970c3534ec1","Page setup") ?? "Page setup"), icon: "pages", onClick: showPageSetup },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_441fd948b74354","Print") ?? "Print"), icon: "print", onClick: function () { if (root.print) root.print(); }, shortcut: "Ctrl+P" }
        ] },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_5b9378df7220c1","Edit") ?? "Edit"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4004b71744b54e","Undo") ?? "Undo"), icon: "undo", onClick: performUndo, shortcut: "Ctrl+Z" }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c6c0222a77068a","Redo") ?? "Redo"), icon: "redo", onClick: performRedo, shortcut: "Ctrl+Y" }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_53535369713fb9","Cut") ?? "Cut"), onClick: function () { document.execCommand("cut"); }, shortcut: "Ctrl+X" }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_9302911bb13773","Copy") ?? "Copy"), icon: "copy", onClick: function () { document.execCommand("copy"); }, shortcut: "Ctrl+C" },
          // execCommand("paste") is blocked outside extensions; go through the
          // async clipboard API and fall back to telling the user the shortcut.
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_ebe7a89280761a","Paste") ?? "Paste"), onClick: function () { pasteFromClipboard(false); }, shortcut: "Ctrl+V" }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7aa73bfa142682","Paste without formatting") ?? "Paste without formatting"), onClick: function () { pasteFromClipboard(true); }, shortcut: "Ctrl+Shift+V" }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_65046f5dd815ba","Select all") ?? "Select all"), onClick: function () { document.execCommand("selectAll"); }, shortcut: "Ctrl+A" }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4fc60207629a44","Delete") ?? "Delete"), icon: "trash", onClick: deleteSelection }, "-", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_60060ed2b4f549","Find and replace") ?? "Find and replace"), onClick: showFindReplace, shortcut: "Ctrl+H" }
        ] },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_2b8e4c9b866e80","View") ?? "View"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_669e1e42b35fa1","Mode") ?? "Mode"), children: function () { const labels = { doc: "Document", visual: "Visual", preview: "Preview" }; return modesAvailable().map(function (mode) { return { label: labels[mode] || mode, checked: state.mode === mode, onClick: function () { setMode(mode); } }; }); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e54fc1b3a14807","Comments") ?? "Comments"), checked: function () { return state.commentsVisible; }, onClick: comments },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8d4d587ae8e3bc","Show document outline") ?? "Show document outline"), checked: function () { return state.showOutline; }, onClick: function () { state.showOutline = !state.showOutline; renderOutlinePanel(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8b5e9957f3632d","Pageless") ?? "Pageless"), checked: function () { return !!M.getPath(state.doc, "settings.pageless"); }, onClick: togglePageless }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_9d9351df5da72d","Collapse side panels") ?? "Collapse side panels"), onClick: function () { setSideCollapsed("rail", true); setSideCollapsed("inspector", true); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c556f9e226aae6","Show print layout") ?? "Show print layout"), checked: function () { return state.printLayout; }, onClick: function () { state.printLayout = !state.printLayout; updateRootClass(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e876f0635f37c9","Show ruler") ?? "Show ruler"), checked: function () { return state.showRuler; }, onClick: function () { state.showRuler = !state.showRuler; updateRootClass(); renderRulerUI(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8c569cf679205d","Show non-printing characters") ?? "Show non-printing characters"), checked: function () { return state.showNonPrinting; }, onClick: function () { state.showNonPrinting = !state.showNonPrinting; updateRootClass(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_b4ff33c54a8197","Full screen") ?? "Full screen"), icon: "fit", onClick: toggleFullscreen }
        ] },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_900227393b1fd1","Insert") ?? "Insert"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_8c751c81403a14","Media…") ?? "Media…"), icon: "image", onClick: function () { showDocInsertMenu(dom.menubar.querySelector('[data-menu-name="Insert"]'), "media"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d48d96e38bceb3","Widget") ?? "Widget"), icon: "widget", children: function () { return widgetMenuItems(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_82b1d793f02583","Table") ?? "Table"), icon: "table", submenuClass: "fmde-table-picker-menu", children: function () {
            const caret = docProjection.caretTarget();
            return [{ render: function () { return tableSizePicker(function (rows, columns) { docProjection.insertFlowNode(createTableNode(rows, columns, "flow"), caret); }); } }];
          } },
          modesAvailable().indexOf("visual") !== -1 ? { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cc716752648335","Drawing") ?? "Drawing"), onClick: function () { setMode("visual"); showStatus("Visual mode opened for drawing"); } } : null,
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_92d934625f9102","Audio…") ?? "Audio…"), icon: "microphone", onClick: function () { showDocInsertMenu(dom.menubar.querySelector('[data-menu-name="Insert"]'), "audio"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d3650f8e5e95a2","Special characters") ?? "Special characters"), onClick: showSpecialCharacters },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d75f99bbd59dd6","Footnote") ?? "Footnote"), onClick: insertFootnote, shortcut: "Ctrl+Alt+F" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_40a678432af3c8","Table of contents") ?? "Table of contents"), onClick: insertTableOfContents },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_2b12985ff331fa","Link") ?? "Link"), icon: "link", onClick: showLinkDialog, shortcut: "Ctrl+K" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_b026774dbae1c5","Horizontal line") ?? "Horizontal line"), icon: "line", onClick: insertRule },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_523ad56305df70","Page break") ?? "Page break"), icon: "pagebreak", onClick: function () { docProjection.insertPageBreak(); }, shortcut: "Ctrl+Enter" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e8fb20678aca87","Bookmark") ?? "Bookmark"), onClick: function () { const caret = docProjection.caretTarget(); if (!caret) { showStatus("Click in the document first", true); return; } const list = M.deepClone(M.getPath(state.doc, "metadata.bookmarks") || []); list.push({ id: M.generateId("bookmark"), node_id: caret.node_id, block_id: caret.block_id, offset: caret.offset, created_at: new Date().toISOString() }); runCommands([{ type: "doc.set", prop: "metadata.bookmarks", value: list }], "bookmark:add"); showStatus("Bookmark added"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_5024c72b09c78a","Header") ?? "Header"), onClick: function () { headerFooter("header"); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cd4ea6358d65b3","Footer") ?? "Footer"), onClick: function () { headerFooter("footer"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_3b321d9a875e5b","Page numbers") ?? "Page numbers"), icon: "pages", onClick: pageNumbers }, "-", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_198a6682f7940c","Comment") ?? "Comment"), icon: "comment", onClick: function () { clickTool("Add comment"); } }
        ].filter(Boolean) },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cdf11b397d38fc","Format") ?? "Format"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_124287f184b88b","Text") ?? "Text"), children: function () { return [
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4feeaa2c564c4a","Bold") ?? "Bold"), onClick: function () { docProjection.format("bold"); }, shortcut: "Ctrl+B" },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4ecc62f00b105d","Italic") ?? "Italic"), onClick: function () { docProjection.format("italic"); }, shortcut: "Ctrl+I" },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_416585cf6011a3","Underline") ?? "Underline"), onClick: function () { docProjection.format("underline"); }, shortcut: "Ctrl+U" },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_66722383b505d9","Strikethrough") ?? "Strikethrough"), onClick: function () { docProjection.format("strikeThrough"); }, shortcut: "Alt+Shift+5" },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4164569716a15c","Superscript") ?? "Superscript"), onClick: function () { docProjection.format("superscript"); }, shortcut: "Ctrl+." },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_35d9bfcd68986c","Subscript") ?? "Subscript"), onClick: function () { docProjection.format("subscript"); }, shortcut: "Ctrl+," },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_24c186bbde1d97","Capitalization") ?? "Capitalization"), children: [
              { label: (globalThis.PlatformLanguage?.text("doc-editor","m_dbd6332920034e","lowercase") ?? "lowercase"), onClick: function () { docProjection.transformSelectionText(function (t) { return t.toLowerCase(); }); } },
              { label: (globalThis.PlatformLanguage?.text("doc-editor","m_708ddf494a6a67","UPPERCASE") ?? "UPPERCASE"), onClick: function () { docProjection.transformSelectionText(function (t) { return t.toUpperCase(); }); } },
              { label: (globalThis.PlatformLanguage?.text("doc-editor","m_66d28bc99949b5","Title Case") ?? "Title Case"), onClick: function () { docProjection.transformSelectionText(function (t) { return t.replace(/\S+/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }); }); } }
            ] }
          ]; } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_03994f4e1f002d","Paragraph styles") ?? "Paragraph styles"), onClick: function () { clickTool("Apply a named style to the selected paragraphs"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_9959abedbcdf76","Align & indent") ?? "Align & indent"), children: function () { return [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_8acd145b2aace0","Align left") ?? "Align left"), onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (b) { b.align = "left"; }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_dfe2db476967db","Align center") ?? "Align center"), onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (b) { b.align = "center"; }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_af78123f1ab541","Align right") ?? "Align right"), onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (b) { b.align = "right"; }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a3a5342098f72f","Justify") ?? "Justify"), onClick: function () { docProjection.mutateCoveredBlocks("align-text", function (b) { b.align = "justify"; }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_129a7615785012","Increase indent") ?? "Increase indent"), onClick: function () { docProjection.mutateCoveredBlocks("indent", function (b) { b.indent = Math.min(8, Number(b.indent || 0) + 1); }); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_2ac449cd861fce","Decrease indent") ?? "Decrease indent"), onClick: function () { docProjection.mutateCoveredBlocks("outdent", function (b) { b.indent = Math.max(0, Number(b.indent || 0) - 1); }); } }]; } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_0e1640c5d8c754","Line & paragraph spacing") ?? "Line & paragraph spacing"), onClick: function () { clickTool("Line and paragraph spacing"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e2fd60b52959c7","Paragraph direction") ?? "Paragraph direction"), children: [
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_1e8ba4dc5d5cc1","Left-to-right") ?? "Left-to-right"), onClick: function () { docProjection.mutateCoveredBlocks("direction", function (b) { delete b.direction; }); } },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f2e56d6f29e4b7","Right-to-left") ?? "Right-to-left"), onClick: function () { docProjection.mutateCoveredBlocks("direction", function (b) { b.direction = "rtl"; }); } }
          ] },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_a99efe09542fd0","Bullets & numbering") ?? "Bullets & numbering"), children: function () { return [
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_589f56c69d8706","Bulleted list") ?? "Bulleted list"), onClick: function () { clickTool("Bulleted list"); } },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_368070fc078263","Numbered list") ?? "Numbered list"), onClick: function () { clickTool("Numbered list"); } },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), onClick: function () { clickTool("Checklist"); } }, "-",
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_bc636910dea979","Restart numbering") ?? "Restart numbering"), onClick: function () { docProjection.mutateCoveredBlocks("list-restart", function (b) { if (b.type === "list_item") { b.list_restart = true; delete b.list_continue; } }); } },
            { label: (globalThis.PlatformLanguage?.text("doc-editor","m_217f38df6881ed","Continue previous numbering") ?? "Continue previous numbering"), onClick: function () { docProjection.mutateCoveredBlocks("list-continue", function (b) { if (b.type === "list_item") { b.list_continue = true; delete b.list_restart; } }); } }
          ]; } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_e7e41123605a4f","Borders & shading") ?? "Borders & shading"), onClick: showBordersShadingDialog }, "-",
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_40e02a827129a2","Headers & footers") ?? "Headers & footers"), children: function () { return [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_5024c72b09c78a","Header") ?? "Header"), onClick: function () { headerFooter("header"); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_cd4ea6358d65b3","Footer") ?? "Footer"), onClick: function () { headerFooter("footer"); } }]; } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_3b321d9a875e5b","Page numbers") ?? "Page numbers"), onClick: pageNumbers }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d8d51729d83107","Page orientation") ?? "Page orientation"), onClick: showPageSetup }, "-", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_7be1a0c063bd9d","Clear formatting") ?? "Clear formatting"), icon: "clearformat", onClick: function () { docProjection.format("removeFormat"); docProjection.applyStyleRef(null); } }
        ] },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_661f98dcbb2eda","Tools") ?? "Tools"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_4fb436421421cc","Spelling and grammar") ?? "Spelling and grammar"), icon: "spellcheck", checked: state.spellcheck, onClick: function () { clickTool("Spelling and grammar"); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_5d63803b636282","Spelling & grammar check") ?? "Spelling & grammar check"), icon: "spellcheck", onClick: showSpellingPanel },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_425b432505615b","Autocorrect") ?? "Autocorrect"), checked: function () { return state.autocorrect !== false; }, onClick: function () { state.autocorrect = state.autocorrect === false ? true : false; } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_d9cce4b2626051","Word count") ?? "Word count"), onClick: showWordCount, shortcut: "Ctrl+Shift+C" },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_0c6f2d36d3d866","Word count while typing") ?? "Word count while typing"), checked: function () { return state.wordCountLive; }, onClick: function () { state.wordCountLive = !state.wordCountLive; updateWordCountChip(); } },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_923aed2a89af34","Review suggested edits") ?? "Review suggested edits"), icon: "comment", onClick: reviewSuggestions },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_bdac714b91b36e","Compare with version") ?? "Compare with version"), onClick: showCompareDialog },
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_bad1d04f3c2f9e","Voice typing") ?? "Voice typing"), icon: "microphone", onClick: function () { if (dom.btnDictate) dom.btnDictate.click(); } }
        ].concat(opts.agentEnabled === false ? [] : ["-", { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f449ca5a90fc35","Translate document with Agent") ?? "Translate document with Agent"), onClick: function () { openDocumentAgent("Translate this document while preserving its formatting and structure."); } }, { label: (globalThis.PlatformLanguage?.text("doc-editor","m_3fe4c1ec7e3810","Document Agent") ?? "Document Agent"), icon: "pencil", onClick: function () { openDocumentAgent(""); } }]).concat(hasDocumentAction("accessibility") ? [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_b59f79dbfa152e","Accessibility") ?? "Accessibility"), onClick: function () { invokeDocumentAction("accessibility"); } }] : []) },
        { label: (globalThis.PlatformLanguage?.text("doc-editor","m_67b289b34e4ca4","Help") ?? "Help"), items: [
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_f9b41a195a8735","Search the menus") ?? "Search the menus"), onClick: function () { showMenuSearch(dom.menuSearch, menuDefinitions); }, shortcut: "Alt+/" },
          ...(opts.agentEnabled === false ? [] : [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_0a4e79f4618e3e","Ask the document Agent") ?? "Ask the document Agent"), onClick: function () { openDocumentAgent(""); } }]),
          { label: (globalThis.PlatformLanguage?.text("doc-editor","m_c046be920a4e35","Keyboard shortcuts") ?? "Keyboard shortcuts"), onClick: showKeyboardShortcuts, shortcut: "Ctrl+/" }
        ] }
      ];
      dom.menuDefinitions = menuDefinitions;
      dom.menuSearch = el("button", { type: "button", class: "fmde-menu-search-btn", html: iconSvg("zoomin") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_f00f13e882810c","Menus") ?? "Menus")}</span>`, title: (globalThis.PlatformLanguage?.text("doc-editor","m_f9b41a195a8735","Search the menus") ?? "Search the menus") });
      dom.menuSearch.addEventListener("click", function () { showMenuSearch(dom.menuSearch, menuDefinitions); });
      dom.menubar.appendChild(dom.menuSearch);
      for (const definition of menuDefinitions) {
        const button = el("button", { type: "button", class: "fmde-menubar-btn", text: definition.label, "data-menu-name": definition.label });
        button.addEventListener("click", function () { showMenu(button, definition.items); });
        dom.menubar.appendChild(button);
      }
    }

    function widgetMenuItems() {
      const caret = docProjection.caretTarget();
      const defs = catalogWidgets().filter(function (def) { return def.id !== "doc.video"; });
      if (!defs.length) return [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_a3604588bc0aa7","No widgets available") ?? "No widgets available"), disabled: true }];
      return defs.map(function (def) { return { label: def.title || def.id, icon: def.icon || "fa-puzzle-piece", onClick: function () { const defaults = def.defaults || {}; docProjection.insertFlowNode(M.createNode("widget", { name: def.title || def.id, anchor: "flow", frame: { x: 0, y: 0, w: (defaults.frame && defaults.frame.w) || 300, h: (defaults.frame && defaults.frame.h) || 120, z: 0, layout: "flow" }, props: { widget: def.id + "@" + (def.version || 1), config: M.deepClone(defaults.config || {}), object_layout: "flow" } }), caret); } }; });
    }

    function createTableNode(rowCount, columnCount, anchor) {
      const rows = Math.max(1, Math.min(20, Math.round(rowCount || 1)));
      const columns = Math.max(1, Math.min(20, Math.round(columnCount || 1)));
      const blankCell = function (text) { return { text: text || "" }; };
      return M.createNode("table", {
        name: "Table", anchor: anchor || "flow",
        frame: { x: 0, y: 0, w: anchor === "page" ? 360 : 0, h: "auto", z: anchor === "page" ? 1 : 0, layout: anchor === "page" ? "absolute" : "flow" },
        props: {
          columns: Array.from({ length: columns }, function () { return { width_frac: 1 / columns }; }),
          rows: Array.from({ length: rows }, function (_, rowIndex) {
            return { cells: Array.from({ length: columns }, function (_, columnIndex) { return blankCell(rowIndex === 0 ? "Column " + (columnIndex + 1) : ""); }) };
          }),
          header: true,
          border_width_pt: 0.75,
          border_color: "#d7dce3",
          cell_padding_pt: 5,
          object_layout: anchor === "page" ? "front" : "flow"
        }
      });
    }

    function tableSizePicker(onChoose) {
      const picker = el("div", { class: "fmde-table-picker", role: "group", "aria-label": "Choose table size" });
      const grid = el("div", { class: "fmde-table-picker-grid" });
      const label = el("div", { class: "fmde-table-picker-label", text: "3 × 3 table" });
      let hoverRows = 3;
      let hoverColumns = 3;
      let gridRows = 4;
      let gridColumns = 4;
      const draw = function () {
        grid.style.gridTemplateColumns = "repeat(" + gridColumns + ", 19px)";
        grid.innerHTML = "";
        for (let row = 1; row <= gridRows; row += 1) {
          for (let column = 1; column <= gridColumns; column += 1) {
            const cell = el("button", {
              type: "button", class: "fmde-table-picker-cell" + (row <= hoverRows && column <= hoverColumns ? " active" : ""),
              "data-table-row": row, "data-table-column": column,
              "aria-label": row + " rows by " + column + " columns"
            });
            grid.appendChild(cell);
          }
        }
        label.textContent = hoverColumns + " × " + hoverRows + " table";
      };
      grid.addEventListener("pointermove", function (event) {
        const cell = event.target.closest(".fmde-table-picker-cell");
        if (!cell) return;
        hoverRows = Number(cell.getAttribute("data-table-row")) || 1;
        hoverColumns = Number(cell.getAttribute("data-table-column")) || 1;
        // The picker follows the pointer in both directions: exactly one
        // unselected row and column remain available as the next expansion.
        gridRows = Math.min(20, hoverRows + 1);
        gridColumns = Math.min(20, hoverColumns + 1);
        draw();
      });
      grid.addEventListener("pointerdown", function (event) {
        const cell = event.target.closest(".fmde-table-picker-cell");
        if (!cell) return;
        event.preventDefault();
        const rows = Number(cell.getAttribute("data-table-row")) || hoverRows;
        const columns = Number(cell.getAttribute("data-table-column")) || hoverColumns;
        closeMenu();
        onChoose(rows, columns);
      });
      picker.appendChild(grid);
      picker.appendChild(label);
      draw();
      return picker;
    }

    function showDocInsertMenu(anchor, kind) {
      // Capture the caret BEFORE the menu interaction moves focus.
      const caretAtOpen = docProjection.caretTarget();
      const insertAtCaret = function (node) { docProjection.insertFlowNode(node, caretAtOpen); };
      const flowFrame = { x: 0, y: 0, w: 0, h: "auto", z: 0 };
      const items = [];

      if (can("images")) {
        items.push({
          label: (globalThis.PlatformLanguage?.text("doc-editor","m_8272e21f1dd4ce","Add media") ?? "Add media"), kind: "media", icon: "image", onClick: function () {
            if (!(opts.media && typeof opts.media.pick === "function")) {
              docProjection.hint("No media picker is configured");
              return;
            }
            const audioOnly = kind === "audio";
            const pickerOptions = audioOnly ? { accept: "audio/*", mediaKind: "audio" } : { accept: "image/*,video/*", mediaKind: "media" };
            Promise.resolve(opts.media.pick(pickerOptions)).then(function (ref) {
              if (!ref) return;
              const contentType = String(ref.content_type || ref.mime_type || ref.type || "").toLowerCase();
              if (audioOnly) {
                insertAtCaret(M.createNode("widget", { name: ref.name || "Audio", anchor: "flow", frame: { x: 0, y: 0, w: 0, h: 54, z: 0 }, props: { widget: "doc.audio@1", config: { media: ref, title: ref.name || "Audio" } } }));
                return;
              }
              const isVideo = contentType.indexOf("video/") === 0 || /\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(String(ref.url || ref.name || ""));
              if (isVideo) {
                insertAtCaret(M.createNode("widget", {
                  name: ref.name || "Video", anchor: "flow",
                  frame: { x: 0, y: 0, w: 0, h: 225, z: 0 },
                  props: { widget: "doc.video@1", config: { media: ref } }
                }));
              } else {
                insertAtCaret(M.createNode("image", {
                  name: ref.name || "Image", anchor: "flow",
                  frame: { x: 0, y: 0, w: 0, h: 180, z: 0 },
                  props: { media: ref, fit: "contain", alt: "" }
                }));
              }
            }).catch(function () { /* picker cancelled */ });
          }
        });
      }

      items.push({
        label: (globalThis.PlatformLanguage?.text("doc-editor","m_82b1d793f02583","Table") ?? "Table"), icon: "table", children: [{
          render: function () {
            return tableSizePicker(function (rows, columns) { insertAtCaret(createTableNode(rows, columns, "flow")); });
          }
        }]
      });

      if (can("widget_insert")) {
        items.push({
          label: (globalThis.PlatformLanguage?.text("doc-editor","m_07e0b1a0e797b1","Checkbox") ?? "Checkbox"), icon: "checkbox", onClick: function () {
            // Inline widget in the run stream: doc.checkbox when registered,
            // else doc.form_field with kind "boolean" (contract §9 fallback).
            const hasCheckbox = !!findWidgetDef("doc.checkbox", 1);
            const widgetRef = hasCheckbox ? "doc.checkbox@1" : "doc.form_field@1";
            const config = hasCheckbox
              ? { label: "", output_key: "chk_" + M.generateId("k").slice(-6) }
              : { kind: "boolean", label: "", output_key: "chk_" + M.generateId("k").slice(-6) };
            const props = { widget: widgetRef, config: config };
            if (caretAtOpen && caretAtOpen.block_id) {
              props.after_block = caretAtOpen.block_id;
              props.inline_offset = 9999; // append to the block's run stream
            }
            insertAtCaret(M.createNode("widget", {
              name: "Checkbox", anchor: "inline",
              frame: { x: 0, y: 0, w: 10, h: 10, z: 0 },
              props: props
            }));
          }
        });
      }

      items.push({
        label: (globalThis.PlatformLanguage?.text("doc-editor","m_523ad56305df70","Page break") ?? "Page break"), icon: "pagebreak", onClick: function () {
          docProjection.insertPageBreak(caretAtOpen);
        }
      });

      const compNames = Object.keys(mergedComponentDefs());
      for (const name of compNames.slice(0, 6)) {
        items.push({
          label: "Component: " + name, icon: "component", onClick: (function (compName) {
            return function () {
              insertAtCaret(M.createNode("component_ref", {
                name: compName, anchor: "flow", frame: M.deepClone(flowFrame),
                props: { component: compName, input: {} }
              }));
            };
          })(name)
        });
      }

      items.push({
        label: (globalThis.PlatformLanguage?.text("doc-editor","m_d51dbec5ca55d1","Repeater") ?? "Repeater"), icon: "list", onClick: function () {
          insertAtCaret(M.createNode("repeater", {
            name: "Repeater", anchor: "flow", frame: M.deepClone(flowFrame),
            props: {
              source: "{{params.items}}",
              component: compNames[0] || "",
              as: "row",
              layout: { direction: "column", columns: 1, gap_pt: 6 },
              break_rules: {},
              empty_text: "No rows."
            }
          }));
        }
      });

      const widgets = catalogWidgets();
      for (const def of widgets.slice(0, 6)) {
        items.push({
          label: "Widget: " + (def.title || def.id), icon: "widget", onClick: (function (widgetDef) {
            return function () {
              const defaults = widgetDef.defaults || {};
              const h = (defaults.frame && defaults.frame.h) || 120;
              insertAtCaret(M.createNode("widget", {
                name: widgetDef.title || widgetDef.id, anchor: "flow",
                frame: { x: 0, y: 0, w: 0, h: h, z: 0 },
                props: { widget: widgetDef.id + "@" + (widgetDef.version || 1), config: M.deepClone(defaults.config || {}) }
              }));
            };
          })(def)
        });
      }

      if (kind === "media" || kind === "audio") {
        const pickerItem = items.find(function (item) { return item && item.kind === "media"; });
        if (pickerItem) pickerItem.onClick();
        else docProjection.hint("Media isn't available in this document");
        return;
      }
      else if (kind === "table") {
        const tableItem = items.find(function (item) { return item && item.label && item.label.indexOf("Table") === 0; });
        if (tableItem && tableItem.onClick) { tableItem.onClick(); return; }
      }
      showMenu(anchor, items);
    }

    /** The permission gate is the host's job: opts.onRequestUnlock may return
     *  a boolean or a promise of one. Without a callback, unlock is granted. */
    function requestUnlock(targetProfile) {
      const gate = typeof opts.onRequestUnlock === "function" ? opts.onRequestUnlock(targetProfile, state.policy.unlock.permission) : true;
      Promise.resolve(gate).then(function (allowed) {
        if (allowed) applyProfile(targetProfile);
      }).catch(function () { /* host denied */ });
    }

    function updateDocSectionStyleControls() {
      const section = currentDocSectionNode();
      if (dom.docBackgroundBtn) {
        dom.docBackgroundBtn.disabled = !section;
        if (section) dom.docBackgroundBtn.style.setProperty("--tool-color", nodeBackgroundColor(section));
      }
      if (dom.docBorderColorBtn) {
        const stroke = strokeState(section);
        dom.docBorderColorBtn.hidden = !section || !(stroke.width > 0);
        dom.docBorderColorBtn.style.setProperty("--tool-color", stroke.color);
        if (dom.docStrokeBtn) { dom.docStrokeBtn.disabled = !section; dom.docStrokeBtn.classList.toggle("active", !!section && stroke.width > 0); }
        if (dom.docCornersBtn) { dom.docCornersBtn.disabled = !section; dom.docCornersBtn.style.setProperty("--corner-preview", Math.min(8, cornerValue(section)) + "px"); }
      }
    }

    function updateToolbarState() {
      const selCount = state.selection.length;
      if (dom.btnUndo) dom.btnUndo.disabled = !engine.canUndo();
      if (dom.btnRedo) dom.btnRedo.disabled = !engine.canRedo();
      if (dom.zoomLabel) dom.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
      if (dom.btnGroup) dom.btnGroup.disabled = selCount < 2;
      if (dom.btnUngroup) {
        const first = selCount === 1 ? state.nodeIndex.get(state.selection[0]) : null;
        dom.btnUngroup.disabled = !(first && first.node.type === "frame" && (first.node.children || []).length);
      }
      const zBtns = [dom.btnFront, dom.btnForward, dom.btnBackward, dom.btnBack];
      const structuralSelection = state.selection.some(isStructuralSection);
      for (const btn of zBtns) if (btn) btn.disabled = selCount < 1 || structuralSelection;
      if (dom.btnAlign) dom.btnAlign.disabled = selCount < 2;
      if (dom.btnDuplicate) dom.btnDuplicate.disabled = selCount < 1;
      if (dom.btnDelete) dom.btnDelete.disabled = selCount < 1;
      if (dom.visualTextTools) {
        const element = visualElementNode();
        const context = visualTextContext();
        dom.visualTextTools.hidden = !element;
        if (dom.visualFontTools) dom.visualFontTools.hidden = !context;
        if (element) {
          const stroke = strokeState(element);
          if (dom.visualBackgroundBtn) dom.visualBackgroundBtn.style.setProperty("--tool-color", nodeBackgroundColor(element));
          if (dom.visualCornersBtn) dom.visualCornersBtn.style.setProperty("--corner-preview", Math.min(8, cornerValue(element)) + "px");
          if (dom.visualStrokeBtn) dom.visualStrokeBtn.classList.toggle("active", stroke.width > 0);
          if (dom.visualBorderColorBtn) {
            dom.visualBorderColorBtn.hidden = !(stroke.width > 0);
            dom.visualBorderColorBtn.style.setProperty("--tool-color", stroke.color);
          }
        }
        const value = visualTextState(context);
        if (value) {
          if (dom.visualFontBtn) {
            const font = fontPresentation(value.family);
            const label = dom.visualFontBtn.querySelector("span");
            if (label) {
              label.textContent = font.label;
              label.style.fontFamily = font.css;
            }
          }
          if (dom.visualSizeBtn) dom.visualSizeBtn.textContent = String(Math.round(value.size));
          if (dom.visualFmtButtons) for (const key of ["bold", "italic", "underline"]) dom.visualFmtButtons[key].classList.toggle("active", !!value[key]);
          if (dom.visualColorBtn) dom.visualColorBtn.style.setProperty("--tool-color", value.color);
        }
      }
      updateDocSectionStyleControls();
    }

    // ---- inline-profile popover ---------------------------------------------------------------------

    function positionPopover() {
      if (state.profile !== "inline") {
        dom.popover.hidden = true;
        return;
      }
      if (!state.selection.length) {
        dom.popover.hidden = true;
        return;
      }
      const id = state.selection[0];
      const box = overlayBox(id);
      if (!box || !box.pageId) { dom.popover.hidden = true; return; }
      const entry = entryForPage(box.pageId);
      if (!entry) { dom.popover.hidden = true; return; }
      dom.popover.hidden = false;
      const pageRect = entry.pageEl.getBoundingClientRect();
      const canvasRect = dom.canvas.getBoundingClientRect();
      const pxPerPt = pageRect.width / entry.w_pt;
      let left = pageRect.left - canvasRect.left + dom.canvas.scrollLeft + (box.x + box.w) * pxPerPt + 14;
      let top = pageRect.top - canvasRect.top + dom.canvas.scrollTop + box.y * pxPerPt;
      const maxLeft = dom.canvas.scrollLeft + dom.canvas.clientWidth - dom.popover.offsetWidth - 12;
      if (left > maxLeft) left = Math.max(dom.canvas.scrollLeft + 12, pageRect.left - canvasRect.left + dom.canvas.scrollLeft + box.x * pxPerPt - dom.popover.offsetWidth - 14);
      const maxTop = dom.canvas.scrollTop + dom.canvas.clientHeight - dom.popover.offsetHeight - 12;
      if (top > maxTop) top = Math.max(dom.canvas.scrollTop + 12, maxTop);
      dom.popover.style.left = left + "px";
      dom.popover.style.top = top + "px";
    }

    // ---- left rail -----------------------------------------------------------------------------------

    function insertTabAvailable() {
      // Flag-driven (contracts §10): any insert capability lights the tab.
      // Identical for the built-ins (designer/document → true, fill → false;
      // inline never reaches here — renderRail returns early for it).
      return can("widget_insert") || can("shapes") || can("images");
    }

    function renderRail() {
      dom.railTabs.innerHTML = "";
      dom.railBody.innerHTML = "";
      if (state.profile === "fill" || state.profile === "inline") return;
      const tabs = [];
      if (state.doc.kind === "document") tabs.push({ id: "pages", icon: "pages", label: (globalThis.PlatformLanguage?.text("doc-editor","m_a6c13e38e7e96e","Pages") ?? "Pages") });
      tabs.push({ id: "layers", icon: "layers", label: (globalThis.PlatformLanguage?.text("doc-editor","m_6492ba879f94b7","Layers") ?? "Layers") });
      if (insertTabAvailable()) tabs.push({ id: "insert", icon: "plus", label: (globalThis.PlatformLanguage?.text("doc-editor","m_900227393b1fd1","Insert") ?? "Insert") });
      if (!tabs.some(function (tab) { return tab.id === state.activeRailTab; })) state.activeRailTab = tabs[0] ? tabs[0].id : "layers";
      for (const tab of tabs) {
        const btn = el("button", {
          type: "button",
          class: "fmde-rail-tab" + (state.activeRailTab === tab.id ? " active" : ""),
          html: iconSvg(tab.icon) + "<span>" + esc(tab.label) + "</span>"
        });
        btn.addEventListener("click", function () {
          state.activeRailTab = tab.id;
          renderRail();
        });
        dom.railTabs.appendChild(btn);
      }
      const collapseBtn = el("button", { type: "button", class: "fmde-rail-collapse", title: (globalThis.PlatformLanguage?.text("doc-editor","m_80936f789d4bde","Collapse panel") ?? "Collapse panel"), html: iconSvg("chevleft") });
      collapseBtn.addEventListener("click", function () { setSideCollapsed("rail", true); });
      dom.railTabs.appendChild(collapseBtn);
      renderRailBody();
    }

    function renderRailBody() {
      if (state.profile === "fill" || state.profile === "inline") return;
      dom.railBody.innerHTML = "";
      if (state.activeRailTab === "pages") renderPagesTab(dom.railBody);
      else if (state.activeRailTab === "layers") renderLayersTab(dom.railBody);
      else if (state.activeRailTab === "insert") renderInsertTab(dom.railBody);
    }

    function renderPagesTab(body) {
      const pages = state.doc.pages || [];
      const list = el("div", { class: "fmde-page-list" });
      const manage = can("page_manage");
      let dragPageId = null;
      pages.forEach(function (page, index) {
        const active = page.id === state.currentPageId;
        const card = el("div", {
          class: "fmde-page-card" + (active ? " active" : ""),
          draggable: manage ? "true" : false
        },
          el("div", { class: "fmde-page-num", text: String(index + 1) }),
          el("div", { class: "fmde-page-meta" },
            el("div", { class: "fmde-page-name", text: page.name || "Page " + (index + 1) }),
            el("div", { class: "fmde-page-role", text: page.role || "body" })
          ),
          manage ? el("div", { class: "fmde-page-actions" },
            iconBtn("copy", "Duplicate page", function (ev) {
              ev.stopPropagation();
              duplicatePage(page.id);
            }, "fmde-btn-sm"),
            iconBtn("trash", "Delete page", function (ev) {
              ev.stopPropagation();
              runCommands([{ type: "page.remove", page_id: page.id }], "page.remove");
            }, "fmde-btn-sm")
          ) : null
        );
        card.addEventListener("click", function () {
          state.currentPageId = page.id;
          state.selectedPageId = page.id;
          setSelection([], { keepInspector: true });
          renderInspector();
          renderRailBody();
          scrollToPage(page.id);
        });
        if (manage) {
          card.addEventListener("dragstart", function (ev) {
            dragPageId = page.id;
            ev.dataTransfer.effectAllowed = "move";
            try { ev.dataTransfer.setData("text/plain", page.id); } catch (err) { /* IE */ }
          });
          card.addEventListener("dragover", function (ev) {
            if (!dragPageId || dragPageId === page.id) return;
            ev.preventDefault();
            card.classList.add("dragover");
          });
          card.addEventListener("dragleave", function () { card.classList.remove("dragover"); });
          card.addEventListener("drop", function (ev) {
            ev.preventDefault();
            card.classList.remove("dragover");
            if (!dragPageId || dragPageId === page.id) return;
            runCommands([{ type: "page.move", page_id: dragPageId, index: index }], "page.move");
            dragPageId = null;
          });
        }
        list.appendChild(card);
      });
      body.appendChild(list);
      if (manage) {
        const addBtn = el("button", { type: "button", class: "fmde-add-btn", html: iconSvg("plus") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_4d405fa2a01074","Add page") ?? "Add page")}</span>` });
        addBtn.addEventListener("click", function () {
          const currentIndex = pages.findIndex(function (page) { return page.id === state.currentPageId; });
          const page = M.createPage("body");
          const result = runCommands([{ type: "page.insert", page: page, index: currentIndex === -1 ? pages.length : currentIndex + 1 }], "page.insert");
          if (result.ok) {
            state.currentPageId = page.id;
            state.selectedPageId = page.id;
            renderRailBody();
            renderInspector();
            scrollToPage(page.id);
          }
        });
        body.appendChild(addBtn);
      }
    }

    function duplicatePage(pageId) {
      const found = M.findPage(state.doc, pageId);
      if (!found) return;
      const clone = M.deepClone(found.page);
      clone.id = M.generateId("pg");
      clone.name = (clone.name || "Page") + " copy";
      clone.children = M.reassignIds(clone.children || []);
      const result = runCommands([{ type: "page.insert", page: clone, index: found.index + 1 }], "page.duplicate");
      if (result.ok) {
        state.currentPageId = clone.id;
        renderRailBody();
        scrollToPage(clone.id);
      }
    }

    function scrollToPage(pageId) {
      const entry = entryForPage(pageId);
      if (entry && entry.pageEl.scrollIntoView) { allowExplicitCanvasScroll(); entry.pageEl.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }

    function nodeDisplayName(node) {
      if (node.name) return node.name;
      if (node.type === "text") {
        const first = node.props && node.props.blocks && node.props.blocks[0];
        const text = first && first.runs ? first.runs.map(function (r) { return r.text || ""; }).join("") : "";
        if (text.trim()) return text.trim().slice(0, 24);
      }
      if (node.type === "widget") {
        const ref = widgetRefParts(node.props && node.props.widget);
        return ref.id || "Widget";
      }
      return NODE_TYPE_LABELS[node.type] || node.type;
    }

    function nodeTypeIcon(node) {
      switch (node.type) {
        case "text": return "text";
        case "image": return "image";
        case "widget": return "widget";
        case "frame": return "frame";
        case "component_ref": return "component";
        case "repeater": return "list";
        case "page_break": return "pagebreak";
        case "table": return "table";
        case "shape": {
          const shape = node.props && node.props.shape;
          if (shape === "ellipse") return "ellipse";
          if (shape === "line") return "line";
          if (shape === "polygon" || shape === "path") return "polygon";
          return "rect";
        }
        default: return "rect";
      }
    }

    function renderLayersTab(body) {
      // View docs list the root's children (there are no pages to select).
      const view = isViewDoc();
      const page = !view && state.currentPageId ? M.findPage(state.doc, state.currentPageId) : null;
      if (!view && !page) {
        body.appendChild(el("div", { class: "fmde-empty", text: "No page selected" }));
        return;
      }
      const header = el("div", { class: "fmde-layers-head", text: view ? "Page" : page.page.name || "Page " + (page.index + 1) });
      body.appendChild(header);
      const list = el("div", { class: "fmde-layer-list" });
      let dragNodeId = null;

      const renderLevel = function (nodes, depth, container) {
        // View pages: the top level is the stack of sections, which read down
        // the page — listing them by z (i.e. reversed) is nonsense. Inside a
        // section, z IS the visual stacking, so front-most comes first.
        const sectionLevel = isViewDoc() && depth === 0;
        const ordered = sectionLevel ? nodes.slice() : nodes.slice().sort(function (a, b) {
          const za = (a.frame && a.frame.z) || 0;
          const zb = (b.frame && b.frame.z) || 0;
          if (za !== zb) return zb - za;
          return nodes.indexOf(b) - nodes.indexOf(a);
        });
        ordered.forEach(function (node) {
          const selected = state.selection.indexOf(node.id) !== -1;
          const hidden = node.visible === false;
          const locked = !!(node.locks && (node.locks.move === true || node.locks.delete === true));
          const row = el("div", {
            class: "fmde-layer-row" + (selected ? " selected" : "") + (hidden ? " hidden-node" : ""),
            style: { paddingLeft: (10 + depth * 16) + "px" },
            draggable: can("z_order") && depth === 0 ? "true" : false
          },
            el("span", { class: "fmde-layer-ic", html: iconSvg(nodeTypeIcon(node)) }),
            el("span", { class: "fmde-layer-name", text: nodeDisplayName(node) }),
            iconBtn(locked ? "lock" : "unlock", locked ? "Unlock" : "Lock", function (ev) {
              ev.stopPropagation();
              const value = locked ? {} : { move: true, resize: true, rotate: true, delete: true, content: true };
              runCommands([{ type: "node.set", node_id: node.id, prop: "locks", value: value }], "lock");
            }, "fmde-btn-sm fmde-layer-lock" + (locked ? " on" : "")),
            iconBtn(hidden ? "eyeoff" : "eye", hidden ? "Show" : "Hide", function (ev) {
              ev.stopPropagation();
              runCommands([{ type: "node.set", node_id: node.id, prop: "visible", value: hidden }], "visibility");
            }, "fmde-btn-sm fmde-layer-eye" + (hidden ? " on" : ""))
          );
          row.addEventListener("click", function () {
            setSelection([node.id]);
            renderRailBody();
          });
          if (can("z_order") && depth === 0) {
            row.addEventListener("dragstart", function (ev) {
              dragNodeId = node.id;
              ev.dataTransfer.effectAllowed = "move";
              try { ev.dataTransfer.setData("text/plain", node.id); } catch (err) { /* IE */ }
            });
            row.addEventListener("dragover", function (ev) {
              if (!dragNodeId || dragNodeId === node.id) return;
              ev.preventDefault();
              row.classList.add("dragover");
            });
            row.addEventListener("dragleave", function () { row.classList.remove("dragover"); });
            row.addEventListener("drop", function (ev) {
              ev.preventDefault();
              row.classList.remove("dragover");
              if (!dragNodeId || dragNodeId === node.id) return;
              // Convert the visual position (top = front) into a z index.
              const zTarget = (node.frame && node.frame.z) || 0;
              runCommands([{ type: "node.reorder", node_id: dragNodeId, to: zTarget }], "reorder");
              dragNodeId = null;
            });
          }
          container.appendChild(row);
          if (node.type === "frame" && Array.isArray(node.children) && node.children.length) {
            renderLevel(node.children, depth + 1, container);
          }
        });
      };
      const topLevel = view ? ((state.doc.root && state.doc.root.children) || []) : (page.page.children || []);
      renderLevel(topLevel, 0, list);
      if (!topLevel.length) {
        list.appendChild(el("div", { class: "fmde-empty", text: "Nothing on this page yet" }));
      }
      body.appendChild(list);
    }

    function catalogWidgets() {
      const catalogDefs = (opts.catalog && opts.catalog.widgets) || [];
      const defs = catalogDefs.length ? catalogDefs : (root.FMDocWidgets && root.FMDocWidgets.list ? root.FMDocWidgets.list() : []);
      // Single photos and videos belong to the editor's media insertion flow.
      // Their widget definitions remain registered so legacy documents render.
      return defs.filter(function (def) {
        return def && def.id && def.id !== "doc.photo" && def.id !== "doc.video" && widgetInsertAllowed(def.id);
      }).map(function (def) {
        let registered = null;
        try { registered = root.FMDocWidgets && root.FMDocWidgets.get ? root.FMDocWidgets.get(def.id, def.version || 1) : null; } catch (err) { registered = null; }
        if (!registered) return def;
        return Object.assign({}, registered, def, {
          defaults: def.defaults || registered.defaults,
          configPanel: def.configPanel || registered.configPanel,
          icon: def.icon || registered.icon
        });
      });
    }

    function renderInsertTab(body) {
      const tile = function (icon, label, spec) {
        const t = el("button", { type: "button", class: "fmde-tile", html: '<span class="fmde-tile-ic">' + iconSvg(icon) + "</span><span>" + esc(label) + "</span>" });
        t.addEventListener("click", function () { beginPendingInsert(Object.assign({ label: label }, spec)); });
        t.addEventListener("dblclick", function () {
          cancelPendingInsert();
          // View docs have no pages (currentPageId stays null); node.insert
          // with a null page_id lands in the view root (FMDocModel.nodeContainer).
          const pageId = state.currentPageId;
          if (!pageId && !isViewDoc()) return;
          const node = buildInsertNode(Object.assign({ label: label }, spec), null, pageId);
          insertBuiltNode(node, pageId);
        });
        return t;
      };
      const sectionEl = function (title) {
        const s = el("div", { class: "fmde-insert-section" }, el("div", { class: "fmde-insert-title", text: title }));
        body.appendChild(s);
        return s;
      };

      const basics = sectionEl("Basics");
      const basicsGrid = el("div", { class: "fmde-tile-grid" });
      basicsGrid.appendChild(tile("text", "Text", { kind: "text" }));
      basicsGrid.appendChild(tile("frame", "Frame", { kind: "frame" }));
      if (can("images")) basicsGrid.appendChild(tile("image", "Image", { kind: "image" }));
      basics.appendChild(basicsGrid);

      if (can("shapes")) {
        const shapes = sectionEl("Shapes");
        const grid = el("div", { class: "fmde-tile-grid" });
        grid.appendChild(tile("rect", "Rectangle", { kind: "shape", shape: "rect" }));
        grid.appendChild(tile("ellipse", "Ellipse", { kind: "shape", shape: "ellipse" }));
        grid.appendChild(tile("line", "Line", { kind: "shape", shape: "line" }));
        grid.appendChild(tile("polygon", "Triangle", { kind: "shape", shape: "polygon" }));
        shapes.appendChild(grid);
      }

      const widgets = catalogWidgets();
      if (widgets.length && can("widget_insert")) {
        const section = sectionEl("Widgets");
        const grid = el("div", { class: "fmde-tile-grid" });
        for (const def of widgets) {
          const disabled = def.disabled === true;
          const t = el("button", {
            type: "button",
            class: "fmde-tile fmde-tile-widget" + (disabled ? " disabled" : ""),
            disabled: disabled,
            title: disabled ? (def.disabled_reason || "This feature is disabled for this organization.") : "",
            style: disabled ? { filter: "grayscale(1)", opacity: "0.42", cursor: "not-allowed" } : null,
            html: '<span class="fmde-tile-ic">' + iconSvg(def.icon || "fa-puzzle-piece") + "</span><span>" + esc(def.title || def.id) + (disabled ? " · disabled" : "") + "</span>"
          });
          t.addEventListener("click", function () { if (!disabled) beginPendingInsert({ kind: "widget", widget: def, label: def.title || def.id }); });
          t.addEventListener("dblclick", function () {
            if (disabled) return;
            cancelPendingInsert();
            if (!state.currentPageId && !isViewDoc()) return;
            const node = buildInsertNode({ kind: "widget", widget: def }, null, state.currentPageId);
            insertBuiltNode(node, state.currentPageId);
          });
          grid.appendChild(t);
        }
        section.appendChild(grid);
      }
    }

    // ---- inspector: field factories --------------------------------------------------------------------

    function fieldRow(label, control, cls) {
      return el("div", { class: "fmde-field" + (cls ? " " + cls : "") },
        el("label", { class: "fmde-field-label", text: label }),
        el("div", { class: "fmde-field-control" }, control)
      );
    }

    function sectionBox(title, options) {
      options = options || {};
      const body = el("div", { class: "fmde-section-body" });
      let rootEl;
      if (title) {
        rootEl = el("details", { class: "fmde-section fmde-section-collapsible" + (options.className ? " " + options.className : "") },
          el("summary", { class: "fmde-section-title" }, el("span", { text: title }), el("span", { class: "fmde-section-chevron", html: iconSvg("chevright") })),
          body
        );
        const persisted = options.persistKey && state.inspectorSectionOpen.has(options.persistKey)
          ? state.inspectorSectionOpen.get(options.persistKey)
          : options.open !== false;
        rootEl.open = persisted;
        if (options.persistKey) rootEl.addEventListener("toggle", function () { state.inspectorSectionOpen.set(options.persistKey, rootEl.open); });
      } else {
        rootEl = el("div", { class: "fmde-section" + (options.className ? " " + options.className : "") }, body);
      }
      return { root: rootEl, body: body };
    }

    function commitGuarded(commands, label) {
      state.suppressInspector = true;
      try {
        return runCommands(commands, label);
      } finally {
        state.suppressInspector = false;
      }
    }

    function numberInput(value, onCommit, o) {
      o = o || {};
      const input = el("input", { class: "fmde-input", type: "number", value: value === undefined || value === null ? "" : String(value) });
      if (o.min !== undefined) input.min = o.min;
      if (o.max !== undefined) input.max = o.max;
      input.step = o.step !== undefined ? o.step : "1";
      if (o.disabled) input.disabled = true;
      const commit = function () {
        const parsed = parseFloat(input.value);
        if (Number.isFinite(parsed)) onCommit(parsed);
      };
      input.addEventListener("change", commit);
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { commit(); input.blur(); }
        ev.stopPropagation();
      });
      return input;
    }

    function textInputField(value, onCommit, o) {
      o = o || {};
      const input = el("input", { class: "fmde-input", type: "text", value: value === undefined || value === null ? "" : String(value), placeholder: o.placeholder || "" });
      if (o.disabled) input.disabled = true;
      input.addEventListener("change", function () { onCommit(input.value); });
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { onCommit(input.value); input.blur(); }
        ev.stopPropagation();
      });
      return input;
    }

    function textareaField(value, onCommit, o) {
      o = o || {};
      const area = el("textarea", { class: "fmde-input fmde-textarea", rows: "3", placeholder: o.placeholder || "" });
      area.value = value === undefined || value === null ? "" : String(value);
      if (o.disabled) area.disabled = true;
      area.addEventListener("change", function () { onCommit(area.value); });
      area.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
      return area;
    }

    function selectField(value, options, onCommit, o) {
      o = o || {};
      const select = el("select", { class: "fmde-input fmde-select" });
      for (const opt of options || []) {
        const v = Array.isArray(opt) ? opt[0] : isObj(opt) ? opt.value : opt;
        const label = Array.isArray(opt) ? (opt[1] !== undefined ? opt[1] : opt[0]) : isObj(opt) ? (opt.label !== undefined ? opt.label : opt.value) : opt;
        const optionEl = el("option", { value: String(v), text: String(label) });
        if (String(v) === String(value)) optionEl.selected = true;
        select.appendChild(optionEl);
      }
      if (o.disabled) select.disabled = true;
      select.addEventListener("change", function () { onCommit(select.value); });
      return select;
    }

    function toggleField(value, onCommit, o) {
      o = o || {};
      const btn = el("button", { type: "button", class: "fmde-toggle" + (value ? " on" : ""), "aria-pressed": value ? "true" : "false" }, el("span", { class: "fmde-toggle-knob" }));
      if (o.disabled) btn.disabled = true;
      btn.addEventListener("click", function () {
        const next = !btn.classList.contains("on");
        btn.classList.toggle("on", next);
        btn.setAttribute("aria-pressed", next ? "true" : "false");
        onCommit(next);
      });
      return btn;
    }

    function isHexColor(value) {
      return /^#[0-9a-fA-F]{3,8}$/.test(String(value || ""));
    }

    function colorField(value, onCommit, o) {
      o = o || {};
      const wrap = el("div", { class: "fmde-colorfield" });
      const swatch = el("input", { class: "fmde-color-swatch", type: "color", value: isHexColor(value) ? value : "#111827" });
      const text = el("input", { class: "fmde-input fmde-color-text", type: "text", value: value === undefined || value === null ? "" : String(value), placeholder: (globalThis.PlatformLanguage?.text("doc-editor","m_62b3446993e99d","#000000 or var(--fm-primary)") ?? "#000000 or var(--fm-primary)") });
      if (o.disabled) { swatch.disabled = true; text.disabled = true; }
      swatch.addEventListener("input", function () {
        text.value = swatch.value;
        onCommit(swatch.value);
      });
      text.addEventListener("change", function () {
        if (isHexColor(text.value)) swatch.value = text.value.length === 4 ? "#" + text.value.slice(1).split("").map(function (c) { return c + c; }).join("") : text.value.slice(0, 7);
        onCommit(text.value);
      });
      text.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
      wrap.appendChild(swatch);
      wrap.appendChild(text);
      return wrap;
    }

    function catalogFonts() {
      // Always retain the editor's system-font fallbacks even when a host
      // supplies a narrower downloadable-font catalog. Existing documents
      // commonly use Arial, and it must remain selectable rather than merely
      // rendering as an unnamed browser fallback.
      const supplied = opts.catalog && Array.isArray(opts.catalog.fonts) ? opts.catalog.fonts : [];
      const seen = new Set();
      return supplied.concat(DEFAULT_FONTS).map(function (font) {
        if (isObj(font)) return { value: font.family || font.value, label: font.label || font.family || font.value };
        return { value: font, label: font };
      }).filter(function (font) {
        const key = fontFamilyKey(font.value || font.label);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function firstFontFamily(value) {
      return String(value || "").split(",")[0].replace(/["']/g, "").trim();
    }

    function fontFamilyKey(value) {
      return firstFontFamily(value).toLowerCase().replace(/[\s_-]+/g, "");
    }

    /** Resolve theme-backed font declarations before they reach the toolbar.
     * A hidden probe lets the browser parse nested CSS variable fallbacks;
     * the catalog remains the source of the friendly English label. */
    function resolvedFontFamily(value) {
      const raw = String(value || "").trim();
      if (!raw || !/^var\(/i.test(raw) || !root || typeof root.getComputedStyle !== "function" || !dom.root) return raw;
      let probe = null;
      try {
        probe = el("span", { "aria-hidden": "true" });
        probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden";
        probe.style.fontFamily = raw;
        dom.root.appendChild(probe);
        const computed = root.getComputedStyle(probe).fontFamily;
        if (computed && !/^var\(/i.test(computed)) return computed;
      } catch (e) { /* lightweight/test DOM: use the catalog fallback below */ }
      finally { try { probe && probe.remove(); } catch (e) { /* noop */ } }
      return raw;
    }

    function catalogFontMatch(value) {
      const raw = String(value || "").trim();
      const resolved = resolvedFontFamily(raw);
      const fonts = catalogFonts();
      for (const candidate of [resolved, raw].filter(Boolean)) {
        const key = fontFamilyKey(candidate);
        const baseKey = key.replace(/regular$/, "");
        const exact = fonts.find(function (font) {
          const valueKey = fontFamilyKey(font.value);
          const labelKey = fontFamilyKey(font.label);
          return key === valueKey || key === labelKey || baseKey === valueKey || baseKey === labelKey;
        });
        if (exact) return exact;
      }
      // CSS variables can remain unresolved in test DOMs. Prefer a catalog
      // face present in the fallback declaration to exposing `var(...)`.
      return fonts.find(function (font) {
        return [firstFontFamily(font.value), String(font.label || "")].filter(Boolean).some(function (name) {
          return raw.toLowerCase().indexOf(name.toLowerCase()) !== -1;
        });
      }) || null;
    }

    function fontPresentation(value) {
      const raw = String(value || "").trim();
      const resolved = resolvedFontFamily(raw);
      const match = catalogFontMatch(raw);
      let family = match ? String(match.value || match.label || "") : firstFontFamily(resolved);
      if (!family || /^var\(/i.test(family)) {
        const fallback = catalogFonts()[0];
        family = String(fallback && (fallback.value || fallback.label) || "Arial");
      }
      return {
        family,
        label: String(match && match.label || family),
        css: String(match && match.value || (!/^var\(/i.test(resolved) && resolved) || family)
      };
    }

    /** Map browser-reported face names back to the family exposed by the
     * editor catalog. Legacy portal CSS registers Montserrat's regular file
     * as `Montserrat-Regular`; computedStyle may therefore return that face
     * name after a caret move. Weight belongs in font.weight, not family. */
    function canonicalFontFamily(value) {
      const family = firstFontFamily(resolvedFontFamily(value));
      const key = fontFamilyKey(family);
      const baseKey = key.replace(/regular$/, "");
      const match = catalogFonts().find(function (font) {
        const valueKey = fontFamilyKey(font.value);
        const labelKey = fontFamilyKey(font.label);
        return key === valueKey || key === labelKey || baseKey === valueKey || baseKey === labelKey;
      });
      return match ? String(match.value || match.label || family) : fontPresentation(value).family;
    }

    function fontField(value, onCommit, o) {
      return selectField(canonicalFontFamily(value) || "", [{ value: "", label: (globalThis.PlatformLanguage?.text("doc-editor","m_4e3add8f997a09","Theme default") ?? "Theme default") }].concat(catalogFonts()), function (v) { onCommit(v || null); }, o);
    }

    function sliderField(value, onCommit, o) {
      o = o || {};
      const wrap = el("div", { class: "fmde-sliderfield" });
      const input = el("input", { class: "fmde-slider", type: "range", min: String(o.min !== undefined ? o.min : 0), max: String(o.max !== undefined ? o.max : 1), step: String(o.step !== undefined ? o.step : 0.01), value: String(value !== undefined && value !== null ? value : (o.fallback !== undefined ? o.fallback : 1)) });
      const label = el("span", { class: "fmde-slider-value", text: String(input.value) });
      if (o.disabled) input.disabled = true;
      input.addEventListener("input", function () { label.textContent = input.value; });
      input.addEventListener("change", function () { onCommit(parseFloat(input.value)); });
      wrap.appendChild(input);
      wrap.appendChild(label);
      return wrap;
    }

    function mediaField(value, onCommit, o) {
      o = o || {};
      const wrap = el("div", { class: "fmde-mediafield" });
      const label = value && (value.url || value.media_id) ? (value.media_id || String(value.url).split("/").pop() || "media") : "None";
      wrap.appendChild(el("span", { class: "fmde-media-name", text: String(label).slice(0, 26), title: value && value.url ? value.url : "" }));
      const pick = el("button", { type: "button", class: "fmde-btn fmde-btn-labeled", html: iconSvg("image") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_bca9e3fd6cf405","Choose") ?? "Choose")}</span>` });
      if (o.disabled || !(opts.media && typeof opts.media.pick === "function")) pick.disabled = true;
      pick.addEventListener("click", function () {
        Promise.resolve(opts.media.pick({ accept: o.accept || "image/*", mediaKind: o.mediaKind || "" })).then(function (ref) {
          if (ref) onCommit(ref);
        }).catch(function () { /* cancelled */ });
      });
      wrap.appendChild(pick);
      return wrap;
    }

    function bindingScopeKeys() {
      const keys = [];
      const scope = opts.resolveScope || {};
      const params = scope.params || {};
      for (const key of Object.keys(params)) keys.push("params." + key);
      const catalogParams = (opts.catalog && opts.catalog.params) || {};
      if (Array.isArray(catalogParams)) {
        for (const key of catalogParams) if (keys.indexOf("params." + key) === -1) keys.push("params." + key);
      } else {
        for (const key of Object.keys(catalogParams)) if (keys.indexOf("params." + key) === -1) keys.push("params." + key);
      }
      for (const ns of ["project", "customer", "org"]) {
        if (scope[ns] && Object.keys(scope[ns]).length) {
          for (const key of Object.keys(scope[ns]).slice(0, 12)) keys.push(ns + "." + key);
        }
      }
      return keys;
    }

    function bindingField(value, onCommit, o) {
      o = o || {};
      const wrap = el("div", { class: "fmde-bindingfield" });
      const input = textInputField(value, onCommit, { placeholder: (globalThis.PlatformLanguage?.text("doc-editor","m_f234fd95050e6e","{{params.value}}") ?? "{{params.value}}") });
      const tokenBtn = el("button", { type: "button", class: "fmde-btn fmde-btn-token", html: iconSvg("token"), title: (globalThis.PlatformLanguage?.text("doc-editor","m_c676528b3a90bd","Insert a data token") ?? "Insert a data token") });
      if (o.disabled) { input.disabled = true; tokenBtn.disabled = true; }
      tokenBtn.addEventListener("click", function () {
        const keys = bindingScopeKeys();
        if (!keys.length) {
          showMenu(tokenBtn, [{ label: (globalThis.PlatformLanguage?.text("doc-editor","m_58ccbeb144648f","No scope data available") ?? "No scope data available"), disabled: true }]);
          return;
        }
        showMenu(tokenBtn, keys.map(function (key) {
          return {
            label: "{{" + key + "}}",
            onClick: function () {
              input.value = (input.value || "") + "{{" + key + "}}";
              onCommit(input.value);
            }
          };
        }));
      });
      wrap.appendChild(input);
      wrap.appendChild(tokenBtn);
      return wrap;
    }

    function listField(value, onCommit, o) {
      o = o || {};
      const items = Array.isArray(value) ? value.slice() : [];
      const itemFields = Array.isArray(o.itemFields) ? o.itemFields : [];
      const allStrings = !itemFields.length && items.every(function (item) { return typeof item === "string"; });
      const wrap = el("div", { class: "fmde-listfield" });
      if (itemFields.length) {
        const renderObjects = function () {
          wrap.innerHTML = "";
          items.forEach(function (item, index) {
            const valueObject = isObj(item) ? Object.assign({}, item) : {};
            const card = el("div", { class: "fmde-list-object" });
            const heading = el("div", { class: "fmde-list-object-head" },
              el("strong", { text: (o.itemLabel || "Item") + " " + (index + 1) })
            );
            heading.appendChild(iconBtn("x", "Remove", function () {
              items.splice(index, 1);
              onCommit(M.deepClone(items));
              renderObjects();
            }, "fmde-btn-sm"));
            card.appendChild(heading);
            itemFields.forEach(function (field) {
              const fieldOptions = {
                disabled: o.disabled,
                min: field.min,
                max: field.max,
                step: field.step,
                placeholder: field.placeholder,
                accept: field.accept,
                mediaKind: field.mediaKind
              };
              let control;
              const commitValue = function (next) {
                valueObject[field.key] = next;
                items[index] = valueObject;
                onCommit(M.deepClone(items));
              };
              if (field.kind === "number") control = numberInput(valueObject[field.key], commitValue, fieldOptions);
              else if (field.kind === "toggle") control = toggleField(!!valueObject[field.key], commitValue, fieldOptions);
              else if (field.kind === "select") control = selectField(valueObject[field.key], field.options || [], commitValue, fieldOptions);
              else if (field.kind === "media") control = mediaField(valueObject[field.key], commitValue, fieldOptions);
              else control = textInputField(valueObject[field.key], commitValue, fieldOptions);
              card.appendChild(fieldRow(field.label || field.key, control));
            });
            wrap.appendChild(card);
          });
          const add = el("button", { type: "button", class: "fmde-add-btn fmde-add-sm", html: iconSvg("plus") + "<span>Add " + (o.itemLabel || "item").toLowerCase() + "</span>" });
          if (o.disabled) add.disabled = true;
          add.addEventListener("click", function () {
            items.push({});
            onCommit(M.deepClone(items));
            renderObjects();
          });
          wrap.appendChild(add);
        };
        renderObjects();
      } else if (allStrings) {
        const renderRows = function () {
          wrap.innerHTML = "";
          items.forEach(function (item, index) {
            const row = el("div", { class: "fmde-list-row" });
            const input = textInputField(item, function (v) {
              items[index] = v;
              onCommit(items.slice());
            });
            row.appendChild(input);
            row.appendChild(iconBtn("x", "Remove", function () {
              items.splice(index, 1);
              onCommit(items.slice());
              renderRows();
            }, "fmde-btn-sm"));
            wrap.appendChild(row);
          });
          const add = el("button", { type: "button", class: "fmde-add-btn fmde-add-sm", html: iconSvg("plus") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_4d801afb3ef0c9","Add item") ?? "Add item")}</span>` });
          add.addEventListener("click", function () {
            items.push("");
            onCommit(items.slice());
            renderRows();
          });
          wrap.appendChild(add);
        };
        renderRows();
      } else {
        const area = el("textarea", { class: "fmde-input fmde-textarea", rows: "4" });
        area.value = JSON.stringify(items, null, 2);
        area.addEventListener("change", function () {
          try {
            const parsed = JSON.parse(area.value);
            if (Array.isArray(parsed)) {
              area.classList.remove("invalid");
              onCommit(parsed);
            } else area.classList.add("invalid");
          } catch (err) {
            area.classList.add("invalid");
          }
        });
        area.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
        wrap.appendChild(area);
      }
      return wrap;
    }

    /** Render one configPanel DSL field (contract §4):
     *  { key, label, kind: text|number|toggle|select|color|font|media|binding|list,
     *    options?, min?, max?, step?, when? } */
    function renderDslField(field, values, commit, disabled) {
      if (!fieldVisible(field, values)) return null;
      const value = M.getPath(values, field.key);
      const onCommit = function (v) { commit(field.key, v); };
      const o = { disabled: disabled, min: field.min, max: field.max, step: field.step, placeholder: field.placeholder, accept: field.accept, mediaKind: field.mediaKind, itemFields: field.itemFields, itemLabel: field.itemLabel };
      let control;
      switch (field.kind) {
        case "number": control = numberInput(value, onCommit, o); break;
        case "toggle": control = toggleField(!!value, onCommit, o); break;
        case "select": control = selectField(value, field.options || [], onCommit, o); break;
        case "color": control = colorField(value, onCommit, o); break;
        case "font": control = fontField(value, onCommit, o); break;
        case "media": control = mediaField(value, onCommit, o); break;
        case "binding": control = bindingField(value, onCommit, o); break;
        case "list": control = listField(value, onCommit, o); break;
        case "textarea": control = textareaField(value, onCommit, o); break;
        case "text":
        default: control = textInputField(value, onCommit, o); break;
      }
      return fieldRow(field.label || field.key, control, ["list", "textarea"].includes(field.kind) ? "fmde-field-stack" : "");
    }

    function fieldVisible(field, values) {
      const when = field.when;
      if (!when) return true;
      if (typeof when === "string") return !!M.evaluateSafe(when, { config: values }, false);
      if (isObj(when)) {
        const v = M.getPath(values, when.key);
        if (when.equals !== undefined) return v === when.equals;
        if (Array.isArray(when.in)) return when.in.indexOf(v) !== -1;
        return !!v;
      }
      return true;
    }

    // ---- inspector panels ---------------------------------------------------------------------------

    function nodeSet(nodeId, prop, value, label) {
      return commitGuarded([{ type: "node.set", node_id: nodeId, prop: prop, value: value }], label || "inspect");
    }

    // Tabs shown in the right tray. "Inspect" (the classic inspector) only
    // exists in visual mode. Preview deliberately exposes only the Agent so
    // the canvas stays presentation-faithful while conversational edits remain
    // available; setup/definition/other host panels stay hidden there.
    function inspectorTabs() {
      const tabs = [];
      if (state.mode === "visual" && state.profile !== "fill" && state.profile !== "inline") {
        tabs.push({ id: "inspect", label: opts.inspectTabLabel || "Inspect", panel: null });
      }
      const tableId = state.tableFocus && state.tableFocus.nodeId || (state.selection.length === 1 && state.nodeIndex.get(state.selection[0]) && state.nodeIndex.get(state.selection[0]).node.type === "table" ? state.selection[0] : null);
      if (tableId) tabs.push({ id: "table", label: (globalThis.PlatformLanguage?.text("doc-editor","m_82b1d793f02583","Table") ?? "Table"), panel: null, tableId: tableId });
      for (const panel of state.sidePanels) {
        if (state.mode === "preview" && String(panel.id) !== "agent") continue;
        tabs.push({ id: String(panel.id), label: panel.label || panel.id, panel: panel });
      }
      return tabs;
    }

    function sidePanelHost(panel) {
      let host = state.sidePanelEls.get(panel.id);
      if (!host) {
        host = el("div", { class: "fmde-insp-panel" });
        state.sidePanelEls.set(panel.id, host);
        dom.inspPanels.appendChild(host);
        try { panel.render(host); } catch (err) {
          if (root && root.console) root.console.error("[FMDocEditor] side panel render failed", err);
        }
      }
      return host;
    }

    /** Draw the tab strip + panel visibility; returns the active tab id. */
    function renderInspectorChrome() {
      const tabs = inspectorTabs();
      if (!tabs.length) {
        dom.root.classList.remove("fmde-table-tools");
        dom.inspTabs.hidden = true;
        dom.inspPanels.hidden = true;
        dom.inspBody.hidden = false;
        return "inspect";
      }
      if (!tabs.some(function (t) { return t.id === state.activeInspTab; })) state.activeInspTab = tabs[0].id;
      dom.inspTabs.hidden = false;
      dom.inspTabs.innerHTML = "";
      for (const tab of tabs) {
        const btn = el("button", {
          type: "button",
          class: "fmde-rail-tab" + (tab.id === state.activeInspTab ? " active" : ""),
          text: tab.label
        });
        btn.addEventListener("click", (function (tabId) {
          return function () {
            if (state.activeInspTab === tabId) return;
            state.activeInspTab = tabId;
            renderInspector();
            emit("sidepanel", tabId);
          };
        })(tab.id));
        dom.inspTabs.appendChild(btn);
      }
      const active = tabs.find(function (t) { return t.id === state.activeInspTab; });
      const isInspect = !active || !active.panel;
      dom.inspBody.hidden = !isInspect;
      dom.inspPanels.hidden = isInspect;
      if (!isInspect) {
        state.sidePanelEls.forEach(function (hostEl) { hostEl.hidden = true; });
        sidePanelHost(active.panel).hidden = false;
      }
      dom.root.classList.toggle("fmde-table-tools", !!tabs.some(function (tab) { return tab.id === "table"; }));
      return state.activeInspTab;
    }

    function renderInspector() {
      if (state.suppressInspector) return;
      const activeTab = renderInspectorChrome();
      const tableId = state.tableFocus && state.tableFocus.nodeId || (state.selection.length === 1 && state.nodeIndex.get(state.selection[0]) && state.nodeIndex.get(state.selection[0]).node.type === "table" ? state.selection[0] : null);
      if (activeTab === "table" && tableId) {
        dom.inspBody.innerHTML = "";
        const tableInfo = state.nodeIndex.get(tableId);
        if (tableInfo) renderTableInspector(dom.inspBody, tableInfo.node, tableId);
        dom.popover.hidden = true;
        return;
      }
      if (state.mode !== "visual") {
        dom.inspBody.innerHTML = "";
        dom.popover.hidden = true;
        return;
      }
      if (activeTab !== "inspect") {
        dom.popover.hidden = true;
        return;
      }
      const target = state.profile === "inline" ? dom.popover : dom.inspBody;
      if (state.profile === "inline") dom.inspBody.innerHTML = "";
      target.innerHTML = "";
      if (state.profile === "fill") {
        dom.inspBody.appendChild(el("div", { class: "fmde-empty", text: "Fill in the highlighted fields, then hand the document back." }));
        return;
      }
      if (state.selection.length > 1) renderMultiInspector(target);
      else if (state.selection.length === 1) renderNodeInspector(target, state.selection[0]);
      else if (state.selectedPageId) renderPageInspector(target, state.selectedPageId);
      else renderDocumentInspector(target);
      positionPopover();
    }

    function renderMultiInspector(target) {
      const head = sectionBox(null);
      head.body.appendChild(el("div", { class: "fmde-inspector-head", text: state.selection.length + " elements selected" }));
      target.appendChild(head.root);
      if (can("free_transform")) {
        const align = sectionBox("Align");
        const grid = el("div", { class: "fmde-align-grid" });
        const btns = [
          ["alignleft", "Align left", function () { alignSelection("left"); }],
          ["alignch", "Align center", function () { alignSelection("hcenter"); }],
          ["alignright", "Align right", function () { alignSelection("right"); }],
          ["aligntop", "Align top", function () { alignSelection("top"); }],
          ["aligncv", "Align middle", function () { alignSelection("vcenter"); }],
          ["alignbottom", "Align bottom", function () { alignSelection("bottom"); }],
          ["disth", "Distribute horizontally", function () { distributeSelection("h"); }],
          ["distv", "Distribute vertically", function () { distributeSelection("v"); }]
        ];
        for (const spec of btns) grid.appendChild(iconBtn(spec[0], spec[1], spec[2]));
        align.body.appendChild(grid);
        target.appendChild(align.root);
      }
      if (can("group")) {
        const actions = sectionBox(null);
        const groupBtn = el("button", { type: "button", class: "fmde-add-btn", html: iconSvg("group") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_94b143195db5cf","Group selection") ?? "Group selection")}</span>` });
        groupBtn.addEventListener("click", groupSelection);
        actions.body.appendChild(groupBtn);
        target.appendChild(actions.root);
      }
    }

    function widgetFieldGroup(widgetId, field) {
      if (field.group) return String(field.group);
      const key = String(field.key || "");
      if (/^(title|subtitle|caption)$/.test(key)) return "Content";
      if (/^(layout|columns|photo_shape|align|gap|link_style)/.test(key)) return "Layout";
      if (/^(show_|autoplay|newest_first)/.test(key)) return "Display";
      if (widgetId === "portal.team" && /(source_mode|selected_user_ids|manual_members|limit)/.test(key)) return "People";
      if (widgetId === "portal.portfolio" && /(source_mode|manual_pairs|before_tag|after_tag|limit)/.test(key)) return "Photos";
      if (widgetId === "portal.activity_feed" && /(source_mode|manual_entries|event_types|days_back|limit)/.test(key)) return "Updates";
      if (widgetId === "portal.nearby_jobs" && /(selection_mode|selected_project_ids|project_types|statuses|radius_miles|limit)/.test(key)) return "Projects";
      return "Settings";
    }

    function renderWidgetInspector(target, node, nodeId) {
      const ref = widgetRefParts(node.props && node.props.widget);
      const def = findWidgetDef(ref.id, ref.version);
      const isWorkflowField = ref.id === "doc.workflow_field";
      const widgetBox = sectionBox(null, { className: "fmde-widget-controls" + (isWorkflowField ? " fmde-widget-controls-field-settings" : "") });
      widgetBox.body.appendChild(el("div", { class: "fmde-widget-controls-head" },
        el("span", { class: "fmde-inspector-type", html: iconSvg("component") }),
        el("strong", { text: isWorkflowField ? "Field Settings" : (def ? (def.title || ref.id) : ref.id || "Widget") }),
        isWorkflowField ? null : el("span", { class: "fmde-widget-ref", text: "v" + ref.version })
      ));
      const configLocked = lockBlocked(node, "content");
      const panel = (def && def.configPanel) || [];
      if (panel.length) {
        const config = (node.props && node.props.config) || {};
        const groups = new Map();
        for (const field of panel) {
          if (!fieldVisible(field, config)) continue;
          const group = widgetFieldGroup(ref.id, field);
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push(field);
        }
        const preferred = ["People", "Photos", "Updates", "Projects", "Content", "Layout", "Display", "Settings"];
        Array.from(groups.keys()).sort(function (a, b) {
          const ai = preferred.indexOf(a); const bi = preferred.indexOf(b);
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        }).forEach(function (name, index) {
          if (isWorkflowField) {
            for (const field of groups.get(name)) {
              const row = renderDslField(field, config, function (key, value) {
                nodeSet(nodeId, "props.config." + key, value, "widget-config");
                renderInspector();
              }, configLocked);
              if (row) widgetBox.body.appendChild(row);
            }
            return;
          }
          const groupBox = sectionBox(name, { open: index === 0, className: "fmde-widget-group", persistKey: "widget:" + nodeId + ":" + name });
          for (const field of groups.get(name)) {
            const row = renderDslField(field, config, function (key, value) {
              nodeSet(nodeId, "props.config." + key, value, "widget-config");
              renderInspector();
            }, configLocked);
            if (row) groupBox.body.appendChild(row);
          }
          widgetBox.body.appendChild(groupBox.root);
        });
      } else widgetBox.body.appendChild(el("div", { class: "fmde-empty", text: "This widget has no configurable options." }));
      target.appendChild(widgetBox.root);
    }

    function renderTableInspector(target, node, nodeId) {
      const props = node.props || {};
      const tableBox = sectionBox("Table", { open: true, persistKey: "node:" + nodeId + ":table" });
      tableBox.body.appendChild(fieldRow("Header row", toggleField(props.header !== false, function (value) {
        nodeSet(nodeId, "props.header", value, "table-style");
      })));
      tableBox.body.appendChild(fieldRow("Alternating rows", toggleField(!!props.row_stripe, function (value) {
        nodeSet(nodeId, "props.row_stripe", value, "table-style");
      })));
      tableBox.body.appendChild(fieldRow("Cell padding", numberInput(num(props.cell_padding_pt, 5), function (value) {
        nodeSet(nodeId, "props.cell_padding_pt", clamp(value, 0, 36), "table-style");
      }, { min: 0, max: 36, step: "0.5" })));
      tableBox.body.appendChild(fieldRow("Line width", numberInput(num(props.border_width_pt, 0.75), function (value) {
        nodeSet(nodeId, "props.border_width_pt", clamp(value, 0, 8), "table-style");
      }, { min: 0, max: 8, step: "0.25" })));
      tableBox.body.appendChild(fieldRow("Line color", colorField(props.border_color || "#d7dce3", function (value) {
        nodeSet(nodeId, "props.border_color", value, "table-style");
      })));
      const align = sectionBox("Cell alignment", { open: false, persistKey: "node:" + nodeId + ":table-align" });
      align.body.appendChild(fieldRow("Horizontal", selectField(props.cell_align || "left", ["left", "center", "right"], function (value) {
        nodeSet(nodeId, "props.cell_align", value, "table-style");
      })));
      align.body.appendChild(fieldRow("Vertical", selectField(props.cell_valign || "top", ["top", "middle", "bottom"], function (value) {
        nodeSet(nodeId, "props.cell_valign", value, "table-style");
      })));
      target.appendChild(tableBox.root);
      target.appendChild(align.root);
    }

    function renderNodeInspector(target, nodeId) {
      const info = state.nodeIndex.get(nodeId);
      if (!info) return;
      const node = info.node;

      const head = sectionBox(null);
      const nameInput = textInputField(node.name || "", function (v) { nodeSet(nodeId, "name", v, "rename"); }, { placeholder: nodeDisplayName(node) });
      head.body.appendChild(el("div", { class: "fmde-inspector-head" },
        el("span", { class: "fmde-inspector-type", html: iconSvg(nodeTypeIcon(node)) }),
        el("span", { text: NODE_TYPE_LABELS[node.type] || node.type })
      ));
      head.body.appendChild(fieldRow("Name", nameInput));
      if (node.type === "widget") renderWidgetInspector(target, node, nodeId);
      if (node.type === "table") renderTableInspector(target, node, nodeId);
      target.appendChild(head.root);

      // Position & size
      const frame = node.frame || {};
      const layout = sectionBox("Position, size and rotation", { open: false, persistKey: "node:" + nodeId + ":transform" });
      const canMove = nodeMovable(node);
      const canSize = nodeResizable(node);
      const canRot = nodeRotatable(node);
      const setFrameProp = function (key, value) {
        const next = Object.assign({}, node.frame);
        next[key] = roundPt(value);
        nodeSet(nodeId, "frame", next, "frame");
      };
      const grid = el("div", { class: "fmde-grid2" });
      grid.appendChild(fieldRow("X", numberInput(roundPt(num(frame.x, 0)), function (v) { setFrameProp("x", v); }, { disabled: !canMove, step: "1" })));
      grid.appendChild(fieldRow("Y", numberInput(roundPt(num(frame.y, 0)), function (v) { setFrameProp("y", v); }, { disabled: !canMove, step: "1" })));
      grid.appendChild(fieldRow("W", numberInput(roundPt(num(frame.w, 0)), function (v) { setFrameProp("w", Math.max(MIN_NODE_SIZE_PT, v)); }, { disabled: !canSize, step: "1", min: MIN_NODE_SIZE_PT })));
      grid.appendChild(fieldRow("H", numberInput(roundPt(num(frame.h, 0)), function (v) { setFrameProp("h", Math.max(MIN_NODE_SIZE_PT, v)); }, { disabled: !canSize, step: "1", min: MIN_NODE_SIZE_PT })));
      layout.body.appendChild(grid);
      if (can("rotate") || frame.rotation) {
        layout.body.appendChild(fieldRow("Rotation", numberInput(num(frame.rotation, 0), function (v) { setFrameProp("rotation", v); }, { disabled: !canRot, step: "1", min: -360, max: 360 })));
      }
      target.appendChild(layout.root);

      // Style
      const styleLocked = lockBlocked(node, "style");
      const style = node.style || {};
      if (node.type !== "widget") {
        const styleBox = sectionBox("Style");
        if (node.type === "shape" || node.type === "frame" || node.type === "text") {
          const fillColor = style.fill ? (typeof style.fill === "string" ? style.fill : style.fill.color) : "";
          styleBox.body.appendChild(fieldRow("Fill", colorField(fillColor, function (v) {
            nodeSet(nodeId, "style.fill", v ? { type: "solid", color: v } : null, "fill");
          }, { disabled: styleLocked })));
        }
        const stroke = style.stroke || {};
        styleBox.body.appendChild(fieldRow("Stroke", colorField(stroke.color || "", function (v) {
          nodeSet(nodeId, "style.stroke", v ? { color: v, width_pt: stroke.width_pt || 1 } : null, "stroke");
        }, { disabled: styleLocked })));
        styleBox.body.appendChild(fieldRow("Stroke width", numberInput(num(stroke.width_pt, 1), function (v) {
          nodeSet(nodeId, "style.stroke.width_pt", Math.max(0, v), "stroke");
        }, { disabled: styleLocked || !stroke.color, step: "0.5", min: 0 })));
        styleBox.body.appendChild(fieldRow("Opacity", sliderField(num(style.opacity, 1), function (v) {
          nodeSet(nodeId, "style.opacity", v, "opacity");
        }, { disabled: styleLocked, min: 0, max: 1, step: 0.05, fallback: 1 })));
        const radius = Array.isArray(style.radius) ? style.radius[0] : num(style.radius, 0);
        styleBox.body.appendChild(fieldRow("Radius", numberInput(num(radius, 0), function (v) {
          nodeSet(nodeId, "style.radius", [v, v, v, v], "radius");
        }, { disabled: styleLocked, step: "1", min: 0 })));
        styleBox.body.appendChild(fieldRow("Shadow", toggleField(!!style.shadow, function (v) {
          nodeSet(nodeId, "style.shadow", v ? { x: 0, y: 3, blur: 10, color: "rgba(15, 23, 42, 0.25)" } : null, "shadow");
        }, { disabled: styleLocked })));
        target.appendChild(styleBox.root);
      }

      if (node.type === "shape" && can("text_style")) {
        const shapeText = node.props && node.props.text_style || {};
        const shapeTextBox = sectionBox("Text");
        shapeTextBox.body.appendChild(fieldRow("Text", textInputField((node.props && node.props.text) || "", function (v) {
          nodeSet(nodeId, "props.text", v, "shape-text");
        }, { disabled: lockBlocked(node, "content"), placeholder: (globalThis.PlatformLanguage?.text("doc-editor","m_f0ff3c03d49a4d","Type on this shape") ?? "Type on this shape") })));
        shapeTextBox.body.appendChild(fieldRow("Color", colorField(shapeText.color || defaultShapeTextColor(node), function (v) {
          nodeSet(nodeId, "props.text_style.color", v || defaultShapeTextColor(node), "shape-text-color");
        }, { disabled: styleLocked })));
        const shapeTextGrid = el("div", { class: "fmde-grid2" });
        shapeTextGrid.appendChild(fieldRow("Size", numberInput(num(shapeText.size_pt, state.doc.settings.base_font_pt || 11), function (v) {
          nodeSet(nodeId, "props.text_style.size_pt", Math.max(4, v), "shape-text-style");
        }, { disabled: styleLocked, min: 4, step: "0.5" })));
        shapeTextGrid.appendChild(fieldRow("Weight", selectField(String(shapeText.weight || "500"), FONT_WEIGHTS, function (v) {
          nodeSet(nodeId, "props.text_style.weight", Number(v), "shape-text-style");
        }, { disabled: styleLocked })));
        shapeTextBox.body.appendChild(shapeTextGrid);
        shapeTextBox.body.appendChild(fieldRow("Align", selectField((node.props && node.props.text_align) || "center", ["left", "center", "right"], function (v) {
          nodeSet(nodeId, "props.text_align", v, "shape-text-align");
        }, { disabled: styleLocked })));
        shapeTextBox.body.appendChild(fieldRow("Vertical", selectField((node.props && node.props.text_valign) || "middle", ["top", "middle", "bottom"], function (v) {
          nodeSet(nodeId, "props.text_valign", v, "shape-text-align");
        }, { disabled: styleLocked })));
        target.appendChild(shapeTextBox.root);
      }

      // Image
      if (node.type === "image") {
        const imageBox = sectionBox("Image");
        imageBox.body.appendChild(fieldRow("Media", mediaField(node.props && node.props.media, function (ref) {
          nodeSet(nodeId, "props.media", ref, "media");
        }, { disabled: lockBlocked(node, "content") || !can("images") })));
        imageBox.body.appendChild(fieldRow("Fit", selectField((node.props && node.props.fit) || "cover", ["cover", "contain", "fill"], function (v) {
          nodeSet(nodeId, "props.fit", v, "fit");
        }, { disabled: styleLocked })));
        target.appendChild(imageBox.root);
        if (can("filters")) {
          const filters = style.filters || {};
          const filterBox = sectionBox("Adjustments");
          const setFilter = function (key, value) { nodeSet(nodeId, "style.filters." + key, value, "filters"); };
          filterBox.body.appendChild(fieldRow("Brightness", sliderField(num(filters.brightness, 1), function (v) { setFilter("brightness", v); }, { min: 0, max: 2, step: 0.05, disabled: styleLocked, fallback: 1 })));
          filterBox.body.appendChild(fieldRow("Contrast", sliderField(num(filters.contrast, 1), function (v) { setFilter("contrast", v); }, { min: 0, max: 2, step: 0.05, disabled: styleLocked, fallback: 1 })));
          filterBox.body.appendChild(fieldRow("Saturation", sliderField(num(filters.saturate, 1), function (v) { setFilter("saturate", v); }, { min: 0, max: 2, step: 0.05, disabled: styleLocked, fallback: 1 })));
          filterBox.body.appendChild(fieldRow("Hue", sliderField(num(filters.hue_rotate_deg, 0), function (v) { setFilter("hue_rotate_deg", v); }, { min: -180, max: 180, step: 1, disabled: styleLocked, fallback: 0 })));
          target.appendChild(filterBox.root);
        }
      }

      // Text
      if (node.type === "text" && can("text_style")) {
        const font = style.font || {};
        const textBox = sectionBox("Text");
        textBox.body.appendChild(fieldRow("Font", fontField(font.family, function (v) {
          nodeSet(nodeId, "style.font.family", v, "font");
        }, { disabled: styleLocked })));
        const grid2 = el("div", { class: "fmde-grid2" });
        grid2.appendChild(fieldRow("Size", numberInput(num(font.size_pt, state.doc.settings.base_font_pt || 11), function (v) {
          nodeSet(nodeId, "style.font.size_pt", Math.max(4, v), "font");
        }, { disabled: styleLocked, step: "0.5", min: 4 })));
        grid2.appendChild(fieldRow("Weight", selectField(String(font.weight || "400"), FONT_WEIGHTS, function (v) {
          nodeSet(nodeId, "style.font.weight", Number(v), "font");
        }, { disabled: styleLocked })));
        textBox.body.appendChild(grid2);
        textBox.body.appendChild(fieldRow("Color", colorField(font.color || "", function (v) {
          nodeSet(nodeId, "style.font.color", v || null, "font");
        }, { disabled: styleLocked })));

        const alignWrap = el("div", { class: "fmde-align-grid fmde-align-text" });
        const currentAlign = (node.props && node.props.blocks && node.props.blocks[0] && node.props.blocks[0].align) || "left";
        for (const alignOpt of [["alignleft", "left"], ["alignch", "center"], ["alignright", "right"]]) {
          const btn = iconBtn(alignOpt[0], "Align " + alignOpt[1], function () {
            const blocks = M.deepClone((node.props && node.props.blocks) || []);
            for (const block of blocks) block.align = alignOpt[1];
            commitGuarded([{ type: "text.edit", node_id: nodeId, blocks: blocks }], "align-text");
            renderInspector();
          }, currentAlign === alignOpt[1] ? "active" : "");
          alignWrap.appendChild(btn);
        }
        textBox.body.appendChild(fieldRow("Align", alignWrap));
        const grid3 = el("div", { class: "fmde-grid2" });
        grid3.appendChild(fieldRow("Line height", numberInput(num(node.props && node.props.line_height, 1.4), function (v) {
          nodeSet(nodeId, "props.line_height", Math.max(0.5, v), "text-style");
        }, { disabled: styleLocked, step: "0.1", min: 0.5, max: 4 })));
        grid3.appendChild(fieldRow("Letter spacing", numberInput(num(node.props && node.props.letter_spacing, 0), function (v) {
          nodeSet(nodeId, "props.letter_spacing", v, "text-style");
        }, { disabled: styleLocked, step: "0.1" })));
        textBox.body.appendChild(grid3);
        target.appendChild(textBox.root);
      }

      // Widget configPanel (contract §4 DSL)
      // Link (props.link — contracts §10): any node can carry a link the
      // renderer turns into an anchor. URL wins over page slug; the slug is
      // resolved by link-aware hosts (site runtime / portal) at render time.
      if (can("text_style")) {
        const link = (node.props && node.props.link) || {};
        const linkBox = sectionBox("Link", { open: node.type !== "widget", persistKey: "node:" + nodeId + ":link" });
        const commitLink = function (patch) {
          const fresh = state.nodeIndex.get(nodeId);
          const current = (fresh && fresh.node.props && fresh.node.props.link) || {};
          const next = Object.assign({}, current, patch);
          for (const key of Object.keys(next)) {
            if (next[key] === undefined || next[key] === null || next[key] === "") delete next[key];
          }
          nodeSet(nodeId, "props.link", Object.keys(next).length ? next : null, "link");
        };
        linkBox.body.appendChild(fieldRow("URL", textInputField(link.href || "", function (v) {
          commitLink({ href: String(v || "").trim() });
        }, { placeholder: "https://example.com" })));
        linkBox.body.appendChild(fieldRow("Page slug", textInputField(link.page || "", function (v) {
          commitLink({ page: String(v || "").trim() });
        }, { placeholder: (globalThis.PlatformLanguage?.text("doc-editor","m_9feb70fbfee35b","about") ?? "about") })));
        linkBox.body.appendChild(fieldRow("New tab", toggleField(link.target === "_blank", function (v) {
          commitLink({ target: v ? "_blank" : "" });
        })));
        target.appendChild(linkBox.root);
      }

      // v2: component instance controls (edit-all is the DEFAULT; detach forks).
      if (node.type === "component_ref") {
        const compBox = sectionBox("Component");
        const compName = (node.props && node.props.component) || "";
        compBox.body.appendChild(el("div", { class: "fmde-widget-ref", text: compName || "(no definition)" }));
        if (node.props && node.props.detached) {
          compBox.body.appendChild(el("div", { class: "fmde-compcard-note", text: "Detached instance — this copy is a fork and no longer follows the component definition." }));
        } else {
          const editBtn = el("button", { type: "button", class: "fmde-add-btn", html: iconSvg("pencil") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_79d80af74e4991","Edit component") ?? "Edit component")}</span>` });
          editBtn.addEventListener("click", function () { openComponentCard(compName); });
          compBox.body.appendChild(editBtn);
          const detachBtn = el("button", { type: "button", class: "fmde-add-btn", html: iconSvg("ungroup") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_b7ce7d7c4247ff","Detach instance") ?? "Detach instance")}</span>` });
          detachBtn.addEventListener("click", function () { detachComponentInstance(nodeId); });
          compBox.body.appendChild(detachBtn);
          compBox.body.appendChild(el("div", { class: "fmde-compcard-note", text: "Editing the component updates every instance. Detaching forks just this one." }));
        }
        target.appendChild(compBox.root);
      }

      // v2: repeater inspector (source binding, component, layout, break rules).
      if (node.type === "repeater") {
        const props = node.props || {};
        const repBox = sectionBox("Repeater");
        repBox.body.appendChild(fieldRow("Source", bindingField(props.source || "", function (v) {
          nodeSet(nodeId, "props.source", v, "repeater");
        })));
        const compNames = Object.keys(mergedComponentDefs());
        repBox.body.appendChild(fieldRow("Component", selectField(props.component || "", [{ value: "", label: (globalThis.PlatformLanguage?.text("doc-editor","m_763a591fba10ba","(none)") ?? "(none)") }].concat(compNames), function (v) {
          nodeSet(nodeId, "props.component", v || null, "repeater");
          renderInspector();
        })));
        const layout = props.layout || {};
        repBox.body.appendChild(fieldRow("Direction", selectField(layout.direction || "column", ["column", "row"], function (v) {
          nodeSet(nodeId, "props.layout.direction", v, "repeater");
        })));
        const repGrid = el("div", { class: "fmde-grid2" });
        repGrid.appendChild(fieldRow("Cols", numberInput(num(layout.columns, 1), function (v) {
          nodeSet(nodeId, "props.layout.columns", Math.max(1, Math.round(v)), "repeater");
        }, { min: 1, step: "1" })));
        repGrid.appendChild(fieldRow("Gap", numberInput(num(layout.gap_pt, 6), function (v) {
          nodeSet(nodeId, "props.layout.gap_pt", Math.max(0, v), "repeater");
        }, { min: 0, step: "1" })));
        repBox.body.appendChild(repGrid);
        target.appendChild(repBox.root);

        const rules = props.break_rules || {};
        const rulesBox = sectionBox("Break rules");
        rulesBox.body.appendChild(fieldRow("Repeat header", toggleField(!!rules.repeat_header, function (v) {
          nodeSet(nodeId, "props.break_rules.repeat_header", v, "repeater");
        })));
        rulesBox.body.appendChild(fieldRow("Header comp.", textInputField(rules.header_component || "", function (v) {
          nodeSet(nodeId, "props.break_rules.header_component", v || null, "repeater");
        }, { placeholder: (globalThis.PlatformLanguage?.text("doc-editor","m_d91bd186a5d36f","component name") ?? "component name") })));
        rulesBox.body.appendChild(fieldRow("Min rows/seg", numberInput(num(rules.min_rows_per_segment, 1), function (v) {
          nodeSet(nodeId, "props.break_rules.min_rows_per_segment", Math.max(1, Math.round(v)), "repeater");
        }, { min: 1, step: "1" })));
        rulesBox.body.appendChild(fieldRow("Keep w/ next", listField(rules.keep_with_next || [], function (v) {
          nodeSet(nodeId, "props.break_rules.keep_with_next", v, "repeater");
        }), "fmde-field-stack"));
        target.appendChild(rulesBox.root);

        if (props.component) {
          const editBox = sectionBox(null);
          const editBtn = el("button", { type: "button", class: "fmde-add-btn", html: iconSvg("pencil") + `<span>${(globalThis.PlatformLanguage?.htmlText("doc-editor","m_79d80af74e4991","Edit component") ?? "Edit component")}</span>` });
          editBtn.addEventListener("click", function () { openComponentCard(props.component); });
          editBox.body.appendChild(editBtn);
          editBox.body.appendChild(el("div", { class: "fmde-compcard-note", text: "Rows come from data — there is no per-row detach. Editing the component restyles every row." }));
          target.appendChild(editBox.root);
        }
      }

      // v2: anchor control (page / flow / inline / float-with-wrap).
      if (info.parentId) renderAnchorSection(target, nodeId, info);
    }

    /** Sibling text blocks a float/inline anchor can attach to. */
    function nearbyBlockOptions(info) {
      const out = [];
      if (!info.parentId) return out;
      const parent = state.nodeIndex.get(info.parentId);
      if (!parent) return out;
      for (const sibling of parent.node.children || []) {
        if (sibling.id === info.node.id || sibling.type !== "text") continue;
        for (const block of (sibling.props && sibling.props.blocks) || []) {
          if (!block.id) continue;
          const text = (block.runs || []).map(function (run) { return run.text || ""; }).join("").trim();
          out.push({ value: block.id, label: (text || block.type || "block").slice(0, 34) });
        }
      }
      return out;
    }

    function renderAnchorSection(target, nodeId, info) {
      const node = info.node;
      const anchor = node.anchor;
      const kind = anchor === "inline" ? "inline" : anchor === "flow" ? "flow" : isObj(anchor) && anchor.to_block !== undefined ? "float" : "page";
      const box = sectionBox("Anchor", { open: node.type !== "widget", persistKey: "node:" + nodeId + ":anchor" });
      const setAnchor = function (value) {
        commitGuarded([{ type: "node.set_anchor", node_id: nodeId, anchor: value }], "anchor");
        renderInspector();
      };
      const blockOptions = nearbyBlockOptions(info);
      box.body.appendChild(fieldRow("Mode", selectField(kind, [
        { value: "page", label: (globalThis.PlatformLanguage?.text("doc-editor","m_8043ddaa3ae53c","Page (absolute)") ?? "Page (absolute)") },
        { value: "flow", label: (globalThis.PlatformLanguage?.text("doc-editor","m_b995f911cf23e3","Flow (block)") ?? "Flow (block)") },
        { value: "inline", label: (globalThis.PlatformLanguage?.text("doc-editor","m_6581692be14e44","Inline (in text)") ?? "Inline (in text)") },
        { value: "float", label: (globalThis.PlatformLanguage?.text("doc-editor","m_bf65599bc96e72","Float (wrap)") ?? "Float (wrap)") }
      ], function (v) {
        if (v === "page") setAnchor(null);
        else if (v === "flow") setAnchor("flow");
        else if (v === "inline") setAnchor("inline");
        else setAnchor({ to_block: blockOptions[0] ? blockOptions[0].value : "", wrap: "right", offset: 0 });
      })));
      if (kind === "float") {
        box.body.appendChild(fieldRow("To block", selectField(anchor.to_block || "", blockOptions.length ? blockOptions : [{ value: "", label: (globalThis.PlatformLanguage?.text("doc-editor","m_2b0d6992d9bd1b","(no sibling blocks)") ?? "(no sibling blocks)") }], function (v) {
          setAnchor(Object.assign({}, anchor, { to_block: v }));
        })));
        box.body.appendChild(fieldRow("Wrap side", selectField(anchor.wrap || "right", ["right", "left", "none"], function (v) {
          setAnchor(Object.assign({}, anchor, { wrap: v }));
        })));
        box.body.appendChild(fieldRow("Offset (pt)", numberInput(num(anchor.offset, 0), function (v) {
          setAnchor(Object.assign({}, anchor, { offset: v }));
        }, { step: "1" })));
      }
      if (kind === "inline") {
        box.body.appendChild(fieldRow("After block", selectField((node.props && node.props.after_block) || "", [{ value: "", label: (globalThis.PlatformLanguage?.text("doc-editor","m_8900c42440c258","(end of frame)") ?? "(end of frame)") }].concat(blockOptions), function (v) {
          nodeSet(nodeId, "props.after_block", v || null, "anchor");
        })));
      }
      target.appendChild(box.root);
    }

    function findWidgetDef(id, version) {
      const defs = (opts.catalog && opts.catalog.widgets) || [];
      let best = null;
      for (const def of defs) {
        if (def.id !== id) continue;
        if (!best || (def.version <= version && def.version > best.version) || (best.version > version && def.version < best.version)) best = def;
      }
      const registry = root && root.FMDocWidgets;
      let registered = null;
      if (registry && typeof registry.get === "function") {
        try { registered = registry.get(id, version); } catch (err) { registered = null; }
      }
      if (best && registered) {
        // Server catalogs often carry only identity/category, while the loaded
        // widget definition owns defaults and its inspector DSL. Contextual
        // server fields (lead forms, user/project options) still win.
        return Object.assign({}, registered, best, {
          defaults: best.defaults || registered.defaults,
          configPanel: best.configPanel || registered.configPanel
        });
      }
      return best || registered;
    }

    function renderPageInspector(target, pageId) {
      const found = M.findPage(state.doc, pageId);
      if (!found) { renderDocumentInspector(target); return; }
      const page = found.page;
      const manage = can("page_manage");
      const head = sectionBox(null);
      head.body.appendChild(el("div", { class: "fmde-inspector-head", text: "Page " + (found.index + 1) }));
      target.appendChild(head.root);
      const box = sectionBox("Page");
      box.body.appendChild(fieldRow("Name", textInputField(page.name || "", function (v) {
        commitGuarded([{ type: "page.set", page_id: pageId, prop: "name", value: v }], "page");
        renderRailBody();
      }, { disabled: !manage })));
      box.body.appendChild(fieldRow("Role", selectField(page.role || "body", M.PAGE_ROLES, function (v) {
        commitGuarded([{ type: "page.set", page_id: pageId, prop: "role", value: v }], "page");
        renderRailBody();
      }, { disabled: !manage })));
      const activeTheme = currentTheme();
      const masters = ((activeTheme && activeTheme.page_masters) || []).map(function (master) { return { value: master.id, label: master.id }; });
      box.body.appendChild(fieldRow("Master", selectField(page.master_ref || "", [{ value: "", label: (globalThis.PlatformLanguage?.text("doc-editor","m_ec31c098b9c0fb","Auto (by role)") ?? "Auto (by role)") }, { value: "none", label: (globalThis.PlatformLanguage?.text("doc-editor","m_0c778faf39c1f9","No styling") ?? "No styling") }].concat(masters), function (v) {
        commitGuarded([{ type: "page.set", page_id: pageId, prop: "master_ref", value: v || null }], "page");
      }, { disabled: !manage })));
      target.appendChild(box.root);
    }

    function renderDocumentInspector(target) {
      const settings = state.doc.settings || {};
      const paper = settings.paper || {};
      const head = sectionBox(null);
      head.body.appendChild(el("div", { class: "fmde-inspector-head", text: state.doc.kind === "view" ? "Page" : (state.doc.metadata && state.doc.metadata.document_type ? "Document — " + state.doc.metadata.document_type : "Document") }));
      target.appendChild(head.root);

      const isView = state.doc.kind === "view";
      const docBox = sectionBox(isView ? "Page" : "Document");
      const editable = state.profile === "designer" || state.profile === "document" || state.profile === "website";
      if (isView) {
        // View surfaces (websites, portal pages): fluid by default; a fixed
        // width is a mode you toggle, then adjust by dragging the page's
        // side handles on the canvas — never a typed number.
        const isFill = viewIsFill();
        const seg = el("div", { class: "fmde-widthseg" });
        const fillBtn = el("button", { type: "button", class: "fmde-widthbtn" + (isFill ? " active" : ""), text: "Fill space", disabled: editable ? null : "true" });
        const fixedBtn = el("button", { type: "button", class: "fmde-widthbtn" + (isFill ? "" : " active"), text: "Fixed width", disabled: editable ? null : "true" });
        fillBtn.addEventListener("click", function () {
          if (isFill) return;
          commitGuarded([{ type: "doc.set", prop: "settings.paper.size", value: "fill" }], "paper");
          setZoom(state.fitMode || "fit-width");
          renderInspector();
        });
        fixedBtn.addEventListener("click", function () {
          if (!isFill) return;
          // Freeze at the page's current rendered width so nothing jumps.
          const pageEl = state.pageEntries[0] && state.pageEntries[0].pageEl;
          const currentPx = pageEl ? pageEl.getBoundingClientRect().width / (state.zoom || 1) : 960;
          const wPt = clamp(Math.round(currentPx * (72 / 96)), 240, 2880);
          commitGuarded([{ type: "doc.set", prop: "settings.paper.size", value: { w_pt: wPt } }], "paper");
          setZoom(state.fitMode || "fit-width");
          renderInspector();
        });
        seg.appendChild(fillBtn);
        seg.appendChild(fixedBtn);
        docBox.body.appendChild(fieldRow("Page width", seg));
        if (!isFill) {
          docBox.body.appendChild(el("div", { class: "fmde-width-hint", text: Math.round(dims().w_pt * (96 / 72)) + " px — drag the page's side handles to resize" }));
        }
      } else {
        docBox.body.appendChild(fieldRow("Paper", selectField(typeof paper.size === "string" ? paper.size : "letter", [
          { value: "letter", label: (globalThis.PlatformLanguage?.text("doc-editor","m_d77b016e8b7aeb","Letter (8.5 x 11 in)") ?? "Letter (8.5 x 11 in)") },
          { value: "legal", label: (globalThis.PlatformLanguage?.text("doc-editor","m_55c41f8952b79e","Legal (8.5 x 14 in)") ?? "Legal (8.5 x 14 in)") },
          { value: "a4", label: "A4" }
        ], function (v) {
          commitGuarded([{ type: "doc.set", prop: "settings.paper.size", value: v }], "paper");
          setZoom(state.fitMode || state.zoom);
        }, { disabled: !editable })));
        docBox.body.appendChild(fieldRow("Orientation", selectField(paper.orientation || "portrait", ["portrait", "landscape"], function (v) {
          commitGuarded([{ type: "doc.set", prop: "settings.paper.orientation", value: v }], "paper");
          setZoom(state.fitMode || state.zoom);
        }, { disabled: !editable })));
      }
      docBox.body.appendChild(fieldRow("Base font", numberInput(num(settings.base_font_pt, 11), function (v) {
        commitGuarded([{ type: "doc.set", prop: "settings.base_font_pt", value: clamp(v, 6, 32) }], "base-font");
      }, { disabled: !editable, step: "0.5", min: 6, max: 32 })));
      target.appendChild(docBox.root);

      const themes = (opts.catalog && opts.catalog.themes) || [];
      if (themes.length) {
        const themeBox = sectionBox("Theme");
        const themeDisabled = M.getPath(state.doc, "metadata.theme_disabled") === true;
        const current = (state.doc.theme_ref && state.doc.theme_ref.theme_id) || (!themeDisabled && themes[0] && (themes[0].id || themes[0].theme_id));
        themeBox.body.appendChild(fieldRow("Theme", selectField(current || "", [{ value: "", label: (globalThis.PlatformLanguage?.text("doc-editor","m_2d4ff8a83b1b5c","None") ?? "None") }].concat(themes.map(function (theme) {
          return { value: theme.id || theme.theme_id, label: theme.name || theme.id };
        })), function (v) {
          const theme = themes.find(function (t) { return (t.id || t.theme_id) === v; });
          commitGuarded([
            { type: "doc.set", prop: "theme_ref", value: v ? { theme_id: v, version: (theme && theme.version) || 1 } : null },
            { type: "doc.set", prop: "metadata.theme_disabled", value: !v }
          ], "theme");
        }, { disabled: !can("theme_edit") })));
        target.appendChild(themeBox.root);
      }
    }

    // ---- chrome refresh --------------------------------------------------------------------------------

    function refreshChrome() {
      updateToolbarState();
      renderRailBody();
      if (!state.suppressInspector) renderInspector();
      else positionPopover();
      refreshComponentCard();
    }

    // ---- public handle ----------------------------------------------------------------------------------

    /** Reflect state.typingFormat (kept caret-accurate by the projection's
     *  selectionchange sync) into the doc-toolbar labels and toggle states. */
    function updateDocToolbarFromCaret() {
      if (state.mode !== "doc") return;
      const f = state.typingFormat;
      if (dom.fontBtn) {
        const font = fontPresentation(f.family);
        f.family = font.family;
        const span = dom.fontBtn.querySelector("span");
        if (span) {
          span.textContent = font.label;
          span.style.fontFamily = font.css;
        }
      }
      if (dom.docSizeBtn && f.size_pt) dom.docSizeBtn.textContent = String(Math.round(f.size_pt));
      if (dom.fmtButtons) {
        for (const key of ["bold", "italic", "underline"]) {
          if (dom.fmtButtons[key]) dom.fmtButtons[key].classList.toggle("active", f[key] === true);
        }
      }
      if (dom.colorBtn && f.color) dom.colorBtn.style.setProperty("--tool-color", f.color);
      if (dom.highlightBtn) dom.highlightBtn.style.setProperty("--tool-color", !f.background || f.background === "transparent" ? "#fff" : f.background);
      updateDocSectionStyleControls();
      if (dom.styleBtn) {
        let ref = null;
        const caret = docProjection.caretTarget();
        if (caret) {
          const info = state.nodeIndex.get(caret.node_id);
          const blocks = (info && info.node.props && info.node.props.blocks) || [];
          const block = blocks.find(function (item) { return item.id === caret.block_id; });
          ref = block && block.style_ref;
        }
        const span = dom.styleBtn.querySelector("span");
        if (span) span.textContent = ref || "Normal text";
      }
      if (state.showRuler) renderRulerUI();
    }

    function onDocSelectionChange() {
      if (state.destroyed || state.mode !== "doc") return;
      clearTimeout(onDocSelectionChange._timer);
      onDocSelectionChange._timer = setTimeout(function () {
        if (state.destroyed || state.mode !== "doc") return;
        docProjection.syncTypingFormatFromCaret();
        sendCollabPresence();
      }, 80);
    }
    document.addEventListener("selectionchange", onDocSelectionChange);
    ensureLanguage(); // warm the dictionary so typing-time autocorrect is ready
    connectCollab();

    function destroy() {
      if (state.destroyed) return;
      docProjection.commitNow("destroy");
      state.destroyed = true;
      docProjection.reset();
      closeComponentCard();
      flushChange.cancel();
      closeMenu();
      clearTimeout(onDocSelectionChange._timer);
      document.removeEventListener("selectionchange", onDocSelectionChange);
      closeFindPanel();
      closeSpellingPanel();
      if (state.collabSession && state.collabSession.transport && state.collabSession.transport.close) {
        try { state.collabSession.transport.close(); } catch (err) { /* gone */ }
        state.collabSession = null;
      }
      if (resizeObserver) resizeObserver.disconnect();
      if (state.renderHandle && typeof state.renderHandle.destroy === "function") {
        try { state.renderHandle.destroy(); } catch (err) { /* renderer already gone */ }
      }
      if (dom.root && dom.root.parentNode) dom.root.parentNode.removeChild(dom.root);
    }

    const editorHandle = {
      getDocument: function () { return M.deepClone(state.doc); },
      setDocument: function (doc, setOptions) {
        preserveCanvasScrollForRender();
        if (state.textEditing) commitTextEdit(true);
        docProjection.reset();
        closeComponentCard();
        state.doc = reconcileAgentDocument(doc, !!(setOptions && setOptions.source === "agent"));
        state.policy = computePolicy();
        state.flags = computeFlags(state.profile);
        engine.clear();
        state.selection = [];
        state.selectedPageId = null;
        state.enterFrameId = null;
        state.dirty = false;
        if (state.renderHandle && typeof state.renderHandle.destroy === "function") {
          try { state.renderHandle.destroy(); } catch (err) { /* ignore */ }
        }
        state.renderHandle = null;
        dom.stage.innerHTML = "";
        rebuildNodeIndex();
        if (state.mode === "doc") ensureDocumentBodyFrame();
        renderCanvas();
        refreshChrome();
      },
      apply: function (command) {
        return engine.apply([command], { label: command && command.type });
      },
      applyBatch: function (commands, label) {
        const list = Array.isArray(commands) ? commands.filter(Boolean) : [];
        return engine.apply(list, { label: label || "batch" });
      },
      undo: function () { return performUndo(); },
      redo: function () { return performRedo(); },
      select: function (ids) {
        setSelection(Array.isArray(ids) ? ids : ids ? [ids] : []);
      },
      selection: function () { return state.selection.slice(); },
      zoom: setZoom,
      setZoomLock: setZoomLock,
      setProfile: applyProfile,
      setMode: setMode,
      // View docs only (contracts §10): mobile-preview width constraint.
      setViewportWidth: setViewportWidth,
      getViewportWidth: function () { return state.viewportWidth; },
      // Shared chrome calls this immediately before an intentional page/node
      // navigation so that navigation wins over in-flight render restoration.
      prepareExplicitScroll: allowExplicitCanvasScroll,
      destroy: destroy,
      on: on,
      // Introspection helpers (supplementary to the contract surface).
      getProfile: function () { return state.profile; },
      getMode: function () { return state.mode; },
      getFlags: function () { return M.deepClone(state.flags); },
      isDirty: function () { return state.dirty; },
      // Tabbed right tray (host side panels): activate a tab by id ("inspect"
      // or a panel id) — expands the tray if it was collapsed.
      openSidePanel: function (id) {
        if (!state.sidePanels.length) return;
        state.activeInspTab = String(id || "inspect");
        if (state.inspectorCollapsed) setSideCollapsed("inspector", false);
        renderInspector();
      },
      activeSidePanel: function () { return state.activeInspTab; }
    };

    // ---- init --------------------------------------------------------------------------------------------

    // Repair previously saved Doc/agent-generated region scaffolds as they are
    // opened, without rewriting custom visual page geometry.
    state.doc = reconcileAgentDocument(state.doc, false);
    state.policy = computePolicy();
    const requestedProfile = PROFILE_FLAGS[opts.profile] ? opts.profile : (state.policy.base_profile && PROFILE_FLAGS[state.policy.base_profile] ? state.policy.base_profile : "document");
    state.baseProfile = requestedProfile;
    state.profile = requestedProfile;
    state.flags = computeFlags(requestedProfile);
    if (modesAvailable().indexOf(state.mode) === -1) state.mode = modesAvailable()[0] || "visual";
    buildChrome();
    rebuildNodeIndex();
    applyProfile(requestedProfile);
    if (state.mode === "doc") ensureDocumentBodyFrame();
    renderCanvas();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(function () { onViewportResize(); });
      resizeObserver.observe(dom.canvas);
    }
    if (root && typeof root.requestAnimationFrame === "function") {
      root.requestAnimationFrame(function () {
        if (!state.destroyed) setZoom("fit-width");
      });
    }

    return editorHandle;
  }

  // ---------------------------------------------------------------------------
  // Profile registration (contracts §10)
  // ---------------------------------------------------------------------------

  /**
   * Register (or replace) an editor profile without editing the library.
   * Flag keys are validated against FEATURE_KEYS; missing keys default to
   * false (a profile only gets what it asks for). options.rank slots the
   * profile into the unlock ladder (PROFILE_RANK) — fractional ranks are
   * fine ("website" sits between document and designer).
   */
  function registerProfile(name, flags, options) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("FMDocEditor.registerProfile: profile name required");
    }
    const key = name.trim();
    if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
      throw new Error("FMDocEditor.registerProfile: flags object required");
    }
    for (const flag of Object.keys(flags)) {
      if (FEATURE_KEYS.indexOf(flag) === -1) {
        throw new Error('FMDocEditor.registerProfile: unknown feature flag "' + flag + '"');
      }
    }
    const preset = {};
    for (const flag of FEATURE_KEYS) {
      const value = flags[flag];
      // Arrays are per-id allow-lists (widget_insert); everything else is boolean.
      preset[flag] = Array.isArray(value) ? value.slice() : value === undefined ? false : !!value;
    }
    PROFILE_FLAGS[key] = preset;
    PROFILE_RANK[key] = options && Number.isFinite(Number(options.rank)) ? Number(options.rank) : PROFILE_RANK.document;
    if (PROFILES.indexOf(key) === -1) PROFILES.push(key);
    // Keep the exported mirror in sync (api.PROFILE_FLAGS is a copy; mount()
    // reads the closure originals).
    if (api && api.PROFILE_FLAGS) {
      api.PROFILE_FLAGS[key] = JSON.parse(JSON.stringify(preset));
      api.PROFILE_RANK = Object.assign({}, PROFILE_RANK);
    }
    return JSON.parse(JSON.stringify(preset));
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  const api = {
    version: 2,
    mount: mount,
    registerProfile: registerProfile,
    MODES: MODES.slice(),
    PROFILES: PROFILES,
    FEATURE_KEYS: FEATURE_KEYS.slice(),
    PROFILE_FLAGS: JSON.parse(JSON.stringify(PROFILE_FLAGS)),
    PROFILE_RANK: Object.assign({}, PROFILE_RANK),
    // DOM-free command engine, exposed for tests and headless tooling.
    _createCommandEngine: createCommandEngine,
    _equalSpacingSnap: equalSpacingSnap,
    _scaleGroupedFrameTree: function (M, groupNode, nextGroupFrame, scaleX, scaleY, frameOverrides, responsive) {
      return scaleGroupedFrameTree(M, groupNode, nextGroupFrame, scaleX, scaleY, frameOverrides, responsive);
    }
  };

  // Built-in `website` profile (web builder, spec §5) — registered through the
  // same public path so registerProfile stays exercised. Rank sits between
  // document (2) and designer (3): a website page can unlock to designer.
  registerProfile("website", {
    free_transform: true, rotate: true, resize: true, shapes: true,
    images: true, filters: true, text_style: true, widget_insert: true,
    page_manage: false, group: true, z_order: true, theme_edit: false,
    bind_edit: false, unlock: false
  }, { rank: (PROFILE_RANK.document + PROFILE_RANK.designer) / 2 });

  return api;
});
