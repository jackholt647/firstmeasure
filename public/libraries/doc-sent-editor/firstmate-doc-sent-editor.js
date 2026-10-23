/**
 * FirstMate document "as sent" editor — FMDocSentEditor.
 *
 * Opens a document exactly as the customer will get it (the same
 * FMDocRenderer static render the PDF uses: line items expanded, totals
 * computed, every field filled, no variables) and lets a person edit it in
 * place. Design: docs/architecture/document-as-sent-editing.md.
 *
 *   - Values that come from the document's data (a line's name, quantity or
 *     amount, a measurement, a param) are inputs: click one, type, and the
 *     host writes the data (POST /documents/:id/as-sent); everything derived
 *     from it recomputes and the page re-renders.
 *   - Calculated values (totals, anything computed) are read only; they
 *     follow their inputs.
 *   - Values from another record (customer, project, company) are read only
 *     here, but can be typed over for this document (a pinned value, flagged
 *     when the record later changes).
 *   - Any other text the template wrote is edited in place; it is saved as a
 *     text override on this document with its bindings kept live.
 *
 * The host owns every write (and so the save path and revisions):
 *
 *   FMDocSentEditor.open({
 *     title, load(): Promise<payload>,
 *     writeInputs(writes): Promise<payload>,          // [{ path, text }]
 *     setTextOverride(nodeId, blocks|null, base): Promise<payload>,
 *     actions: [{ id, label, icon, primary?, run(editor) }],
 *     onClose(changed), themeContext
 *   }) -> { close(), reload() }
 *
 * payload = { resolved_definition, widget_data, theme, theme_vars } from a
 * traced resolution (POST /documents/:id/resolve { trace: true }).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FMDocSentEditor = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  const NS = "documents";
  // Keys new to the catalog come back as the raw fallback, placeholders and all; fill them here.
  const t = (key, fallback, values) => {
    const lang = root.PlatformLanguage;
    const text = (lang && typeof lang.text === "function" ? lang.text(NS, key, fallback, values) : null) || fallback;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => (values && values[name] !== undefined ? String(values[name]) : match));
  };
  const model = () => root.FMDocModel;
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const esc = (value) => String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const STYLE = `
.fmse-overlay{position:fixed;inset:0;z-index:2147483540;display:flex;flex-direction:column;background:#2b3240;font-family:inherit}
.fmse-top{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff;border-bottom:1px solid #dfe3ea;box-shadow:0 1px 3px rgba(15,23,42,.08)}
.fmse-top h2{margin:0;font-size:15px;font-weight:700;color:#1f2733;white-space:nowrap}
.fmse-top .fmse-sub{font-size:12px;color:#647086;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fmse-top .fmse-spacer{flex:1}
.fmse-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #cfd6e0;background:#fff;color:#1f2733;border-radius:7px;padding:7px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.fmse-btn:hover{background:#f3f5f8}
.fmse-btn.primary{background:var(--fm-primary,#d62f2f);border-color:transparent;color:#fff}
.fmse-btn.primary:hover{filter:brightness(.95)}
.fmse-btn:disabled{opacity:.55;cursor:default}
.fmse-state{font-size:12px;color:#647086;white-space:nowrap}
.fmse-state.error{color:#b42318}
.fmse-legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:7px 14px;background:#f6f8fb;border-bottom:1px solid #dfe3ea;font-size:12px;color:#4a5568}
.fmse-legend i.sw{display:inline-block;width:18px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.fmse-scroll{flex:1;overflow:auto;position:relative}
.fmse-stage{margin:24px auto;position:relative;width:max-content}
.fmse-stage .fmdoc-page{box-shadow:0 2px 14px rgba(0,0,0,.35);margin-bottom:22px}
.fmse-stage [data-fmse-text]{cursor:text;border-radius:2px;transition:box-shadow .12s}
.fmse-stage [data-fmse-text]:hover{box-shadow:0 0 0 1px rgba(37,99,235,.45)}
.fmse-stage [data-fmse-text][data-fmse-edited]{box-shadow:inset 3px 0 0 rgba(37,99,235,.55)}
.fmse-stage [data-fmse-text][data-fmse-conflict]{box-shadow:0 0 0 2px #f59e0b}
.fmse-stage [data-fmse-text][contenteditable=true]{outline:2px solid #2563eb;outline-offset:2px;box-shadow:none;cursor:text}
.fmse-stage .fmdoc-run[data-binding-kind=input]{background:rgba(37,99,235,.09);box-shadow:inset 0 -1px 0 rgba(37,99,235,.55);cursor:pointer;border-radius:2px}
.fmse-stage .fmdoc-run[data-binding-kind=input]:hover{background:rgba(37,99,235,.18)}
.fmse-stage .fmdoc-run[data-binding-kind=derived],.fmse-stage .fmdoc-run[data-binding-kind=calculated],.fmse-stage .fmdoc-run[data-binding-kind=output]{cursor:not-allowed}
.fmse-stage .fmdoc-run[data-binding-kind=derived]:hover,.fmse-stage .fmdoc-run[data-binding-kind=calculated]:hover{background:rgba(100,112,134,.14)}
.fmse-stage .fmdoc-run[data-binding-kind=upstream]{cursor:help;box-shadow:inset 0 -1px 0 rgba(100,112,134,.6)}
.fmse-stage .fmdoc-run[data-binding-kind=pinned]{box-shadow:inset 0 -1px 0 rgba(124,58,237,.6)}
.fmse-stage .fmdoc-run[data-fmse-conflict]{background:rgba(245,158,11,.22);box-shadow:inset 0 -2px 0 #f59e0b;cursor:pointer}
.fmse-stage [data-fmse-busy]{opacity:.55}
.fmse-pop{position:absolute;z-index:5;background:#fff;border:1px solid #cfd6e0;border-radius:9px;box-shadow:0 8px 28px rgba(15,23,42,.25);padding:8px;font-size:13px;color:#1f2733;max-width:340px}
.fmse-pop input{font:inherit;font-size:14px;padding:6px 8px;border:1px solid #2563eb;border-radius:6px;width:150px;outline:none}
.fmse-pop .fmse-pop-row{display:flex;gap:6px;align-items:center}
.fmse-pop .fmse-pop-note{margin-top:6px;color:#647086;font-size:12px;line-height:1.35}
.fmse-pop .fmse-pop-err{margin-top:6px;color:#b42318;font-size:12px}
.fmse-pop .fmse-pop-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.fmse-tools{position:absolute;z-index:6;display:flex;gap:4px;align-items:center;background:#1f2733;border-radius:8px;padding:4px;box-shadow:0 6px 20px rgba(15,23,42,.3)}
.fmse-tools button,.fmse-tools select{font:inherit;font-size:12px;color:#fff;background:transparent;border:0;border-radius:5px;padding:5px 8px;cursor:pointer}
.fmse-tools button:hover{background:rgba(255,255,255,.14)}
.fmse-tools select{background:#2d3748}
.fmse-tools .sep{width:1px;align-self:stretch;background:rgba(255,255,255,.2);margin:2px 2px}
.fmse-chip{position:absolute;z-index:4;display:flex;gap:6px;align-items:center;background:#fffbeb;border:1px solid #f59e0b;color:#7c4a03;border-radius:7px;padding:4px 6px 4px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.fmse-chip button{font:inherit;font-size:12px;border:1px solid #e0b354;background:#fff;border-radius:5px;padding:2px 7px;cursor:pointer;color:#7c4a03}
.fmse-loading{color:#e7ecf5;text-align:center;margin:80px auto;font-size:14px}
`;

  function ensureStyle() {
    if (!root.document || root.document.getElementById("fmse-style")) return;
    const style = root.document.createElement("style");
    style.id = "fmse-style";
    style.textContent = STYLE;
    root.document.head.appendChild(style);
  }

  function h(tag, attrs, html) {
    const el = root.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    if (html !== undefined) el.innerHTML = html;
    return el;
  }

  /** nodeId -> resolved node, for every node of a resolved definition. */
  function indexNodes(definition) {
    const nodes = new Map();
    const visit = (node) => {
      if (!isObject(node)) return;
      if (node.id) nodes.set(String(node.id), node);
      (node.children || []).forEach(visit);
    };
    if (definition && definition.root) visit(definition.root);
    ((definition && definition.pages) || []).forEach((page) => (page.children || []).forEach(visit));
    return nodes;
  }

  const RUN_TRACE_KEYS = ["binding", "bound"];
  function runStyle(run) {
    const out = {};
    for (const [key, value] of Object.entries(run || {})) {
      if (key === "text" || key === "bind" || key === "literal" || key === "pinned" || RUN_TRACE_KEYS.indexOf(key) !== -1) continue;
      out[key] = clone(value);
    }
    return out;
  }
  function sameStyle(a, b) { return JSON.stringify(runStyle(a)) === JSON.stringify(runStyle(b)); }

  /** Blocks of a resolved text node without trace data (for change detection). */
  function comparableBlocks(blocks) {
    return JSON.stringify((blocks || []).map((block) => Object.assign({}, block, {
      runs: (block.runs || []).map((run) => (isObject(run.binding) && run.binding.kind !== "pinned" ? { bind: run.binding.expr } : Object.assign(runStyle(run), { text: String(run.text || "") }, isObject(run.binding) ? { pinned: run.binding.value } : {})))
    })));
  }

  /**
   * Read an edited text node back into blocks. Block and run elements carry
   * data-block-index / data-run-index (FMDocRenderer); a bound run is copied
   * from the model (its text is the data's), everything typed is literal text
   * in the style of the run it was typed into; b/i/u from the toolbar become
   * run weight/italic/underline. Blocks the renderer skipped (collapse_empty)
   * keep their place.
   */
  function readBlocks(nodeEl, node) {
    const original = ((node.props && node.props.blocks) || []);
    const out = [];
    const seenBlocks = new Set();
    let previousBase = original[0] || { runs: [] };
    const newBlockFrom = (base) => {
      const block = clone(base) || {};
      delete block.id;
      block.runs = [];
      return block;
    };
    const pushText = (runs, text, base, flags) => {
      if (!text) return;
      const run = Object.assign(runStyle(base), { text });
      if (flags.bold) run.weight = 700;
      if (flags.notBold) run.weight = 400;
      if (flags.italic) run.italic = true;
      if (flags.underline) run.underline = true;
      runs.push(run);
    };
    const mergeRuns = (runs) => {
      // Merge neighbouring literal runs of one style.
      const merged = [];
      for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last && !last.binding && !run.binding && sameStyle(last, run)) last.text += run.text;
        else merged.push(run);
      }
      return merged;
    };
    /** Read one block element; a nested div/p (a line break the browser made) starts a new block. */
    const readInto = (el, block, blockBase) => {
      const cursor = { block, runs: [] };
      const flush = () => { cursor.block.runs = (cursor.block.runs || []).concat(mergeRuns(cursor.runs)); cursor.runs = []; };
      const seenBound = new Set();
      const walk = (parent, base, flags) => {
        parent.childNodes.forEach((child) => {
          if (child.nodeType === 3) { pushText(cursor.runs, child.textContent, base, flags); return; }
          if (child.nodeType !== 1) return;
          const tag = child.tagName.toLowerCase();
          if (tag === "br") return;
          const runIndexAttr = child.getAttribute("data-run-index");
          if (runIndexAttr !== null && child.classList.contains("fmdoc-run")) {
            const modelRun = (blockBase.runs || [])[Number(runIndexAttr)] || {};
            const binding = isObject(modelRun.binding) ? modelRun.binding : null;
            if (binding && binding.kind !== "pinned" && !child.hasAttribute("data-fmse-typeover")) {
              // A value split over two lines/pages is one run.
              if (cursor.block === block && seenBound.has(runIndexAttr)) return;
              seenBound.add(runIndexAttr);
              cursor.runs.push(clone(modelRun));
              return;
            }
            if (binding) {
              const typedOver = child.hasAttribute("data-fmse-typeover");
              const kept = Object.assign(runStyle(modelRun), {
                text: child.textContent,
                binding: typedOver ? { kind: "pinned", expr: binding.expr, value: String(modelRun.text || "") } : clone(binding)
              });
              if (kept.text) cursor.runs.push(kept);
              return;
            }
            walk(child, modelRun, flags);
            return;
          }
          const next = Object.assign({}, flags);
          const style = child.style || {};
          if (tag === "b" || tag === "strong" || /^(bold|[6-9]00)$/.test(String(style.fontWeight || ""))) { next.bold = true; next.notBold = false; }
          if (/^(normal|[1-4]00)$/.test(String(style.fontWeight || ""))) { next.notBold = true; next.bold = false; }
          if (tag === "i" || tag === "em" || style.fontStyle === "italic") next.italic = true;
          if (tag === "u" || /underline/.test(String(style.textDecoration || style.textDecorationLine || ""))) next.underline = true;
          if (tag === "div" || tag === "p") {
            flush();
            const fresh = newBlockFrom(blockBase);
            out.push(fresh);
            cursor.block = fresh;
          }
          walk(child, base, next);
        });
      };
      walk(el, (blockBase.runs || [])[0] || {}, {});
      flush();
    };
    const blockEls = [];
    nodeEl.childNodes.forEach((child) => blockEls.push(child));
    for (const child of blockEls) {
      if (child.nodeType === 3) {
        if (!child.textContent.trim()) continue;
        const fresh = newBlockFrom(previousBase);
        fresh.runs = [Object.assign(runStyle((previousBase.runs || [])[0]), { text: child.textContent })];
        out.push(fresh);
        continue;
      }
      if (child.nodeType !== 1 || child.hasAttribute("data-fmse-ui")) continue;
      const indexAttr = child.getAttribute("data-block-index");
      const index = indexAttr === null ? -1 : Number(indexAttr);
      const base = index >= 0 && original[index] ? original[index] : previousBase;
      const block = index >= 0 && original[index] && !seenBlocks.has(index) ? Object.assign(clone(base), { runs: [] }) : newBlockFrom(base);
      if (index >= 0) { seenBlocks.add(index); block.__index = index; }
      const styleRef = child.getAttribute("data-style-ref");
      if (styleRef && styleRef !== block.style_ref) block.style_ref = styleRef;
      out.push(block);
      readInto(child, block, base);
      previousBase = base;
    }
    // Blocks the renderer did not draw (collapse_empty with nothing in them)
    // stay where they were.
    original.forEach((block, index) => {
      if (seenBlocks.has(index)) return;
      const at = out.findIndex((candidate) => typeof candidate.__index === "number" && candidate.__index > index);
      const kept = Object.assign(clone(block), { __index: index });
      if (at === -1) out.push(kept); else out.splice(at, 0, kept);
    });
    out.forEach((block) => { delete block.__index; });
    return out;
  }

  function bindingLabel(binding) {
    const path = String((binding && binding.path) || "");
    const last = path.split(".").filter((part) => !/^\d+$/.test(part)).pop() || "";
    return last.replace(/_cents$/, "").replace(/_/g, " ");
  }

  function upstreamSource(binding) {
    const rootName = String((binding && binding.path) || "").split(".")[0];
    if (rootName === "customer") return t("as_sent_from_customer", "the customer record");
    if (rootName === "project") return t("as_sent_from_project", "the project");
    if (rootName === "org") return t("as_sent_from_company", "your company settings");
    return t("as_sent_from_document", "this document's details");
  }

  function open(options) {
    const opts = options || {};
    ensureStyle();
    const doc = root.document;
    const overlay = h("div", { class: "fmse-overlay", role: "dialog", "aria-label": t("as_sent_title", "Edit as sent") });
    overlay.innerHTML = `
      <header class="fmse-top">
        <h2>${esc(t("as_sent_title", "Edit as sent"))}</h2>
        <span class="fmse-sub">${esc(opts.title || "")}</span>
        <span class="fmse-spacer"></span>
        <span class="fmse-state" data-fmse-state></span>
        <span data-fmse-actions style="display:flex;gap:8px"></span>
      </header>
      <div class="fmse-legend">
        <span>${esc(t("as_sent_legend_text", "Click any text to change it."))}</span>
        <span><i class="sw" style="background:rgba(37,99,235,.18);box-shadow:inset 0 -1px 0 rgba(37,99,235,.7)"></i>${esc(t("as_sent_legend_input", "Data: change it and everything that follows from it updates"))}</span>
        <span><i class="sw" style="background:rgba(100,112,134,.2)"></i>${esc(t("as_sent_legend_derived", "Calculated: follows the data"))}</span>
        <span><i class="sw" style="background:#fff;box-shadow:inset 0 -1px 0 rgba(100,112,134,.8)"></i>${esc(t("as_sent_legend_upstream", "From another record"))}</span>
      </div>
      <div class="fmse-scroll" data-fmse-scroll><div class="fmse-stage" data-fmse-stage><div class="fmse-loading">${esc(t("as_sent_loading", "Opening the document as it will be sent…"))}</div></div></div>`;
    doc.body.appendChild(overlay);
    const scroll = overlay.querySelector("[data-fmse-scroll]");
    const stage = overlay.querySelector("[data-fmse-stage]");
    const stateEl = overlay.querySelector("[data-fmse-state]");
    let payload = null;
    let nodes = new Map();
    let handle = null;
    let scale = 1;
    let busy = false;
    let changed = false;
    let editing = null; // { nodeId, el, node, tools }
    let pop = null;
    let closed = false;

    const setState = (text, error) => {
      stateEl.textContent = text || "";
      stateEl.classList.toggle("error", !!error);
    };
    const errorText = (error) => String((error && (error.message || (error.data && error.data.message))) || error || t("as_sent_save_failed", "Could not save."));

    const actionsEl = overlay.querySelector("[data-fmse-actions]");
    const api = { close, reload, payload: () => payload };
    (opts.actions || []).forEach((action) => {
      const button = h("button", { type: "button", class: "fmse-btn" + (action.primary ? " primary" : ""), title: action.title || "" }, `${action.icon ? `<i class="fas ${esc(action.icon)}"></i>` : ""}${esc(action.label)}`);
      button.addEventListener("click", async () => {
        await commitEditing();
        action.run(api);
      });
      actionsEl.appendChild(button);
    });

    function pageWidthPx() {
      const dims = (model() && model().paperDimensions && payload) ? model().paperDimensions(payload.resolved_definition) : { w_pt: 612 };
      return dims.w_pt * (96 / 72);
    }

    function render() {
      if (!payload || !root.FMDocRenderer) return;
      closePop();
      const top = scroll.scrollTop;
      scale = Math.min(1.5, Math.max(0.45, (scroll.clientWidth - 64) / pageWidthPx()));
      try { handle && handle.destroy && handle.destroy(); } catch (e) { /* re-render */ }
      stage.innerHTML = "";
      nodes = indexNodes(payload.resolved_definition);
      handle = root.FMDocRenderer.render(stage, {
        document: payload.resolved_definition,
        theme: payload.theme,
        themeContext: Object.assign({}, opts.themeContext || {}, { overrides: payload.theme_vars || {} }),
        widgetData: payload.widget_data || {},
        widgetContext: { outputs: {} },
        mode: "static",
        scale
      }) || {};
      decorate();
      scroll.scrollTop = top;
    }

    /** Mark editable text and data values on the fresh render. */
    function decorate() {
      stage.querySelectorAll("[data-node-id]").forEach((el) => {
        const node = nodes.get(el.getAttribute("data-node-id"));
        if (!node || node.type !== "text" || node.generated || !isObject(node.as_sent)) return;
        el.setAttribute("data-fmse-text", "");
        el.title = t("as_sent_text_hint", "Click to edit this text in this document");
        if (node.as_sent.edited) el.setAttribute("data-fmse-edited", "");
        if (node.as_sent.conflict) el.setAttribute("data-fmse-conflict", "");
      });
      stage.querySelectorAll(".fmdoc-run[data-binding-kind]").forEach((span) => {
        const binding = bindingOf(span);
        if (!binding) return;
        if (binding.kind === "input") span.title = t("as_sent_input_hint", "{label}: click to change. What follows from it updates.", { label: bindingLabel(binding) || t("as_sent_value", "Value") });
        else if (binding.kind === "derived" || binding.kind === "calculated" || binding.kind === "output") span.title = t("as_sent_derived_hint", "Calculated from the document's data. Change the values it comes from to change it.");
        else if (binding.kind === "upstream") span.title = t("as_sent_upstream_hint", "From {source}. Click to type over it in this document only.", { source: upstreamSource(binding) });
        else if (binding.kind === "pinned") {
          span.title = t("as_sent_pinned_hint", "Typed over in this document (it was “{value}”).", { value: binding.value });
          if (binding.conflict) span.setAttribute("data-fmse-conflict", "");
        }
      });
      // Text the template changed after it was edited here: keep or take theirs.
      stage.querySelectorAll("[data-fmse-conflict][data-fmse-text]").forEach((el) => {
        const nodeId = el.getAttribute("data-node-id");
        if (stage.querySelector(`.fmse-chip[data-for="${CSS.escape(nodeId)}"]`)) return;
        const node = nodes.get(nodeId);
        const chip = h("div", { class: "fmse-chip", "data-fmse-ui": "", "data-for": nodeId }, `<span>${esc(t("as_sent_template_changed", "The template's text changed after this was edited."))}</span><button type="button" data-keep>${esc(t("as_sent_keep_mine", "Keep mine"))}</button><button type="button" data-theirs>${esc(t("as_sent_use_template", "Use the template's"))}</button>`);
        placeNear(chip, el, -30);
        chip.querySelector("[data-keep]").addEventListener("click", () => saveText(nodeId, model().boundBlocksToTemplate(node.props.blocks), node.as_sent.fingerprint));
        chip.querySelector("[data-theirs]").addEventListener("click", () => saveText(nodeId, null, null));
      });
    }

    function bindingOf(span) {
      const nodeEl = span.closest("[data-node-id]");
      const blockEl = span.closest("[data-block-index]");
      if (!nodeEl || !blockEl) return null;
      const node = nodes.get(nodeEl.getAttribute("data-node-id"));
      const block = node && node.props && (node.props.blocks || [])[Number(blockEl.getAttribute("data-block-index"))];
      const run = block && (block.runs || [])[Number(span.getAttribute("data-run-index"))];
      return run && isObject(run.binding) ? run.binding : null;
    }

    function placeNear(el, target, offsetY) {
      const stageBox = stage.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      el.style.left = Math.max(0, box.left - stageBox.left) + "px";
      el.style.top = Math.max(0, box.top - stageBox.top + (offsetY || 0)) + "px";
      stage.appendChild(el);
    }

    function closePop() {
      if (pop) { pop.remove(); pop = null; }
    }

    async function run(task, savingText) {
      if (busy) return false;
      busy = true;
      setState(savingText || t("as_sent_saving", "Saving…"));
      stage.setAttribute("data-fmse-busy", "");
      try {
        const next = await task();
        if (next && next.resolved_definition) payload = next;
        changed = true;
        setState(t("as_sent_saved", "Saved"));
        render();
        return true;
      } catch (error) {
        setState(errorText(error), true);
        return false;
      } finally {
        busy = false;
        stage.removeAttribute("data-fmse-busy");
      }
    }

    // ------------------------------------------------------------ inputs
    function inputSpans() {
      return Array.from(stage.querySelectorAll('.fmdoc-run[data-binding-kind="input"]'));
    }

    function openInput(span) {
      const binding = bindingOf(span);
      if (!binding || busy) return;
      closePop();
      const M = model();
      pop = h("div", { class: "fmse-pop", "data-fmse-ui": "" }, `
        <div class="fmse-pop-row"><input type="text" data-fmse-input aria-label="${esc(bindingLabel(binding))}"><button type="button" class="fmse-btn primary" data-fmse-apply>${esc(t("as_sent_apply", "Apply"))}</button></div>
        <div class="fmse-pop-note">${esc(t("as_sent_input_note", "Changes {label} in this document's data. Amounts and totals that follow from it recalculate.", { label: bindingLabel(binding) || t("as_sent_this_value", "this value") }))}</div>
        <div class="fmse-pop-err" data-fmse-err hidden></div>`);
      placeNear(pop, span, span.getBoundingClientRect().height + 4);
      const input = pop.querySelector("[data-fmse-input]");
      input.value = M.boundInputText(binding);
      const original = input.value;
      input.focus();
      input.select();
      const commit = async (moveBy) => {
        const text = input.value;
        if (text === original) { closePop(); if (moveBy) focusSibling(span, moveBy); return; }
        const parsed = M.parseBoundInput(text, binding);
        if (!parsed.ok) {
          const err = pop && pop.querySelector("[data-fmse-err]");
          if (err) { err.hidden = false; err.textContent = t("as_sent_number_expected", "Type a number."); }
          return;
        }
        const path = binding.path;
        const order = inputSpans().indexOf(span);
        closePop();
        const ok = await run(() => opts.writeInputs([{ path, text }]));
        if (ok && moveBy) {
          const spans = inputSpans();
          const next = spans[order + moveBy];
          if (next) openInput(next);
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(0); }
        else if (event.key === "Tab") { event.preventDefault(); commit(event.shiftKey ? -1 : 1); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePop(); }
      });
      pop.querySelector("[data-fmse-apply]").addEventListener("click", () => commit(0));
    }

    function focusSibling(span, moveBy) {
      const spans = inputSpans();
      const next = spans[spans.indexOf(span) + moveBy];
      if (next) openInput(next);
    }

    function openInfo(span) {
      const binding = bindingOf(span);
      if (!binding) return;
      closePop();
      if (binding.kind === "pinned") {
        const conflict = binding.conflict;
        pop = h("div", { class: "fmse-pop", "data-fmse-ui": "" }, `
          <div>${esc(conflict
            ? t("as_sent_pinned_conflict", "You typed over “{was}”. The data now says “{now}”.", { was: binding.value, now: binding.current })
            : t("as_sent_pinned_info", "Typed over “{was}” in this document.", { was: binding.value }))}</div>
          <div class="fmse-pop-actions">
            ${conflict ? `<button type="button" class="fmse-btn" data-keep>${esc(t("as_sent_keep_mine", "Keep mine"))}</button>` : ""}
            <button type="button" class="fmse-btn" data-use-data>${esc(t("as_sent_use_data", "Use the data again"))}</button>
          </div>`);
        placeNear(pop, span, span.getBoundingClientRect().height + 4);
        const nodeEl = span.closest("[data-node-id]");
        const blockIndex = Number(span.closest("[data-block-index]").getAttribute("data-block-index"));
        const runIndex = Number(span.getAttribute("data-run-index"));
        const node = nodes.get(nodeEl.getAttribute("data-node-id"));
        const rewrite = (fn) => {
          const blocks = clone(node.props.blocks);
          fn(blocks[blockIndex].runs[runIndex]);
          closePop();
          saveText(node.id, model().boundBlocksToTemplate(blocks), node.as_sent && node.as_sent.fingerprint);
        };
        const keep = pop.querySelector("[data-keep]");
        if (keep) keep.addEventListener("click", () => rewrite((r) => { r.binding.value = binding.current; }));
        pop.querySelector("[data-use-data]").addEventListener("click", () => rewrite((r) => { r.binding = { kind: "input", expr: binding.expr }; delete r.text; }));
        return;
      }
      if (binding.kind === "upstream") {
        const nodeEl = span.closest("[data-fmse-text]");
        pop = h("div", { class: "fmse-pop", "data-fmse-ui": "" }, `
          <div>${esc(t("as_sent_upstream_info", "This comes from {source}. Change it there to change every document, or type over it in this document only.", { source: upstreamSource(binding) }))}</div>
          ${nodeEl ? `<div class="fmse-pop-actions"><button type="button" class="fmse-btn" data-typeover>${esc(t("as_sent_type_over", "Type over it here"))}</button></div>` : ""}`);
        placeNear(pop, span, span.getBoundingClientRect().height + 4);
        const typeover = pop.querySelector("[data-typeover]");
        if (typeover) typeover.addEventListener("click", () => {
          closePop();
          span.setAttribute("data-fmse-typeover", "");
          startEditing(nodeEl, span);
        });
        return;
      }
      pop = h("div", { class: "fmse-pop", "data-fmse-ui": "" }, `<div>${esc(t("as_sent_derived_info", "This is calculated from the document's data, so it always matches it. Change a quantity, price or other value it comes from and it updates."))}</div>`);
      placeNear(pop, span, span.getBoundingClientRect().height + 4);
    }

    // -------------------------------------------------------------- text
    function startEditing(el, focusSpan) {
      if (busy || (editing && editing.el === el)) return;
      const nodeId = el.getAttribute("data-node-id");
      const node = nodes.get(nodeId);
      if (!node) return;
      const parts = Array.from(stage.querySelectorAll(`[data-node-id="${CSS.escape(nodeId)}"]`));
      if (parts.length > 1) {
        // Text that continues onto the next page is gathered where it starts
        // and edited as one; the page breaks again when it is saved. A
        // paragraph split mid-way joins back into its own block.
        el = parts[0];
        for (const part of parts.slice(1)) {
          Array.from(part.childNodes).forEach((child) => {
            const index = child.nodeType === 1 ? child.getAttribute("data-block-index") : null;
            const blocksSoFar = el.querySelectorAll(":scope > [data-block-index]");
            const last = blocksSoFar[blocksSoFar.length - 1];
            if (index !== null && last && last.getAttribute("data-block-index") === index) {
              // The renderer split the text by character range; nothing was lost.
              Array.from(child.childNodes).forEach((grand) => last.appendChild(grand));
            } else {
              el.appendChild(child);
            }
          });
          part.style.visibility = "hidden";
        }
      }
      closePop();
      editing = { nodeId, el, node, before: comparableBlocks(node.props.blocks) };
      el.querySelectorAll(".fmdoc-run[data-binding-kind]").forEach((span) => {
        if (!span.hasAttribute("data-fmse-typeover") && span.getAttribute("data-binding-kind") !== "pinned") span.setAttribute("contenteditable", "false");
      });
      el.setAttribute("contenteditable", "true");
      el.setAttribute("spellcheck", "true");
      try { doc.execCommand("styleWithCSS", false, false); } catch (e) { /* older engines */ }
      showTools(el, node);
      el.focus();
      if (focusSpan) {
        const range = doc.createRange();
        range.selectNodeContents(focusSpan);
        const selection = root.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    function showTools(el, node) {
      const M = model();
      const styleNames = M && M.availableStyleRefs ? M.availableStyleRefs(payload.resolved_definition, payload.theme) : [];
      const tools = h("div", { class: "fmse-tools", "data-fmse-ui": "" });
      tools.innerHTML = `
        ${styleNames.length ? `<select data-style title="${esc(t("as_sent_paragraph_style", "Paragraph style"))}"><option value="">${esc(t("as_sent_style", "Style"))}</option>${styleNames.map((name) => `<option value="${esc(name)}">${esc(name.replace(/_/g, " "))}</option>`).join("")}</select><span class="sep"></span>` : ""}
        <button type="button" data-cmd="bold" title="${esc(t("as_sent_bold", "Bold"))}"><b>B</b></button>
        <button type="button" data-cmd="italic" title="${esc(t("as_sent_italic", "Italic"))}"><i>I</i></button>
        <button type="button" data-cmd="underline" title="${esc(t("as_sent_underline", "Underline"))}"><u>U</u></button>
        ${node.as_sent && node.as_sent.edited ? `<span class="sep"></span><button type="button" data-restore title="${esc(t("as_sent_restore_hint", "Remove your changes to this text"))}">${esc(t("as_sent_restore", "Use template text"))}</button>` : ""}
        <span class="sep"></span><button type="button" data-done>${esc(t("as_sent_done_text", "Done"))}</button>`;
      placeNear(tools, el, -38);
      editing.tools = tools;
      tools.addEventListener("mousedown", (event) => { if (event.target.tagName !== "SELECT" && event.target.tagName !== "OPTION") event.preventDefault(); });
      tools.querySelectorAll("[data-cmd]").forEach((button) => button.addEventListener("click", () => {
        try { doc.execCommand(button.getAttribute("data-cmd"), false, null); } catch (e) { /* unsupported */ }
      }));
      const select = tools.querySelector("[data-style]");
      if (select) select.addEventListener("change", () => {
        const name = select.value;
        if (!name) return;
        const selection = root.getSelection();
        const anchor = selection && selection.anchorNode;
        const blockEl = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentElement).closest("[data-block-index], .fmdoc-block") : null;
        const target = blockEl && el.contains(blockEl) ? blockEl : el.querySelector(".fmdoc-block");
        if (target) {
          target.setAttribute("data-style-ref", name);
          const style = M.resolveStyleRef(name, payload.resolved_definition, payload.theme);
          const css = M.fontToCss ? M.fontToCss(style.font || style, null) : {};
          Object.entries(css || {}).forEach(([key, value]) => { target.style.setProperty(key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), value); });
        }
        select.value = "";
        el.focus();
      });
      const restore = tools.querySelector("[data-restore]");
      if (restore) restore.addEventListener("click", () => { const id = editing.nodeId; stopEditing(); saveText(id, null, null); });
      tools.querySelector("[data-done]").addEventListener("click", () => commitEditing());
    }

    function stopEditing() {
      if (!editing) return;
      editing.el.removeAttribute("contenteditable");
      if (editing.tools) editing.tools.remove();
      editing = null;
    }

    async function commitEditing() {
      if (!editing) return;
      const current = editing;
      const blocks = readBlocks(current.el, current.node);
      stopEditing();
      if (comparableBlocks(blocks) === current.before) { render(); return; }
      await saveText(current.nodeId, model().boundBlocksToTemplate(blocks), current.node.as_sent && current.node.as_sent.fingerprint);
    }

    function saveText(nodeId, blocks, base) {
      return run(() => opts.setTextOverride(nodeId, blocks, base || null));
    }

    // ----------------------------------------------------------- events
    // The renderer lays pages out (and paginates) after render() returns;
    // mark the final DOM when it says it is ready.
    stage.addEventListener("fmdoc:ready", () => { if (!editing) decorate(); });
    stage.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-fmse-ui]")) return;
      const span = target.closest(".fmdoc-run[data-binding-kind]");
      if (editing && editing.el.contains(target)) return;
      if (editing) { commitEditing(); return; }
      if (span) {
        event.preventDefault();
        if (span.getAttribute("data-binding-kind") === "input") openInput(span);
        else openInfo(span);
        return;
      }
      const textEl = target.closest("[data-fmse-text]");
      if (textEl) { startEditing(textEl); return; }
      closePop();
    });
    stage.addEventListener("focusout", (event) => {
      if (!editing) return;
      const next = event.relatedTarget;
      if (next && (editing.el.contains(next) || (editing.tools && editing.tools.contains(next)))) return;
      setTimeout(() => { if (editing && !editing.el.contains(doc.activeElement) && !(editing.tools && editing.tools.contains(doc.activeElement))) commitEditing(); }, 0);
    });
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (pop) { closePop(); return; }
      if (editing) { commitEditing(); return; }
    };
    doc.addEventListener("keydown", onKey);
    let resizeTimer = 0;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!editing && !pop && payload) render(); }, 150);
    }) : null;
    if (resize) resize.observe(scroll);

    async function reload() {
      setState(t("as_sent_loading_short", "Loading…"));
      try {
        payload = await opts.load();
        setState("");
        render();
      } catch (error) {
        stage.innerHTML = `<div class="fmse-loading">${esc(errorText(error))}</div>`;
        setState(t("as_sent_load_failed", "Could not open the document."), true);
      }
    }

    async function close() {
      if (closed) return;
      await commitEditing();
      closed = true;
      if (resize) resize.disconnect();
      doc.removeEventListener("keydown", onKey);
      try { handle && handle.destroy && handle.destroy(); } catch (e) { /* closing */ }
      overlay.remove();
      if (typeof opts.onClose === "function") opts.onClose(changed);
    }

    reload();
    return api;
  }

  return { open, readBlocks, comparableBlocks };
});
