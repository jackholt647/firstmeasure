/**
 * FMPresentationEditor — the visual editor set up for slideshows.
 *
 * A presentation is an ordinary paged DocModel (FMDocPresent's header says
 * what a slide adds: page.transition, page.steps, props.action, assemblies).
 * This is a thin host over FMVisualEditor, the same editor documents and
 * websites use. It contributes only what is specific to slides:
 *
 *   - one slide on the canvas, the others in the strip (drag to reorder),
 *     with each slide's steps as chips that preview the slide after that step;
 *   - an Animate tab beside Design: the selected element's animations, or the
 *     slide's transition, and the ordered steps;
 *   - an Interactive rail tab: FMDocParts assemblies by preset, and buttons;
 *   - Design additions: slide background and size, a widget's data source,
 *     and "When clicked" for any element;
 *   - Present: FMDocPresent full screen from the current slide.
 *
 * Every edit goes through the editor's command bus (page.set, node.set,
 * doc.set, node.insert), so undo and redo cover all of it.
 *
 *   const editor = FMPresentationEditor.mount(container, {
 *     document, theme, themeContext, media, catalog,
 *     scope,                    // binding data for the canvas and Present ({ org, customer, ... })
 *     sampleState, priceSample, // live state for assemblies (FMDocParts shape) and how to reprice it
 *     onChange(document), onSave(document) -> Promise, onClose()
 *   });
 *   editor.getDocument() / isDirty() / markSaved() / present() / showSlide(id) / previewStep(n) / destroy()
 */
(function (global) {
  'use strict';

  const arr = (value) => (Array.isArray(value) ? value : []);
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const text = (value) => String(value ?? '').trim();
  const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (value) => String(value ?? '').replace(/["\\]/g, '\\$&');

  const EFFECT_GROUPS = [
    { kind: 'enter', label: 'Enter', hint: 'Hidden until its step' },
    { kind: 'exit', label: 'Exit', hint: 'Leaves on its step' },
    { kind: 'emphasis', label: 'Emphasis', hint: 'Draws the eye, stays put' }
  ];
  const EFFECT_ICONS = {
    fade_in: 'fa-circle-half-stroke', rise: 'fa-arrow-up', slide_in: 'fa-arrow-right-to-bracket', zoom_in: 'fa-expand', wipe: 'fa-bars-staggered', draw: 'fa-pen',
    fade_out: 'fa-circle-half-stroke', slide_out: 'fa-arrow-right-from-bracket', zoom_out: 'fa-compress', pulse: 'fa-heart-pulse',
    highlight: 'fa-sun', unhighlight: 'fa-sun', dim: 'fa-moon', undim: 'fa-moon'
  };
  const TRANSITION_ICONS = { none: 'fa-ban', fade: 'fa-circle-half-stroke', slide: 'fa-arrow-right', push: 'fa-angles-right', zoom: 'fa-expand', morph: 'fa-shuffle' };
  const DIRECTION_ICONS = { left: 'fa-arrow-left', right: 'fa-arrow-right', up: 'fa-arrow-up', down: 'fa-arrow-down' };
  const ACTIONS = [['', 'Nothing'], ['next', 'Next step or slide'], ['back', 'Back'], ['first', 'First slide'], ['goto', 'Go to slide\u2026'], ['custom', 'Custom action\u2026']];
  const NODE_ICONS = { text: 'fa-font', image: 'fa-image', shape: 'fa-shapes', frame: 'fa-object-group', widget: 'fa-puzzle-piece', table: 'fa-table' };
  const PART = '#7a5af8';

  const STYLE_ID = 'fmpe-styles';
  const CSS = `
.fmpe{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#f4f6f8}
.fmpe .fmde-insp-panel{padding:0}
.fmpe .fmde-stage [data-part-empty]{visibility:visible!important;opacity:.35}
.fmpe .fmde-stage [data-fmpe-ghost]{opacity:.14!important;filter:grayscale(.5)}
.fmpe .fmde-stage [data-fmpe-dim]{opacity:.22!important}
.fmpe .fmde-stage [data-fmpe-hl]{filter:drop-shadow(0 0 10px var(--fm-primary,#2563eb)) drop-shadow(0 0 2px var(--fm-primary,#2563eb))}
/* strip */
.fmpe .fmwe-ch-pagecard{width:124px}
.fmpe .fmwe-ch-pagecard .label{display:flex;align-items:baseline;justify-content:center;gap:5px;padding:0 2px}
.fmpe .fmwe-ch-pagecard .label b{flex:none;font-weight:900;color:#98a2b3;font-variant-numeric:tabular-nums}
.fmpe .fmwe-ch-pagecard.active .label b{color:inherit}
.fmpe .fmwe-ch-pagecard .label span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.fmpe-chips{display:flex;align-items:center;justify-content:center;gap:3px;height:18px}
.fmpe-chip{flex:none;min-width:18px;height:16px;padding:0 4px;border:1px solid #d5dae2;border-radius:8px;background:#fff;color:#667085;font:800 9px/1 inherit;display:inline-grid;place-items:center;cursor:pointer;font-variant-numeric:tabular-nums}
.fmpe-chip:hover{border-color:var(--fmwe-primary);color:var(--fmwe-primary)}
.fmpe-chip.on{border-color:var(--fmwe-primary);background:var(--fmwe-primary);color:#fff}
.fmpe-chip.auto{border-style:dashed}
.fmpe-chip i{font-size:7px}
.fmpe-chips .dot{flex:none;width:5px;height:5px;border-radius:50%;background:#d0d5dd}
.fmpe-chips .more{font:800 8.5px/1 inherit;color:#98a2b3}
.fmpe-tmark{position:absolute;left:-13px;top:26px;z-index:3;display:grid;place-items:center;width:17px;height:17px;border:1px solid #d5dae2;border-radius:50%;background:#fff;color:#667085;font-size:7.5px;box-shadow:0 1px 3px rgba(16,24,40,.1)}
/* step preview banner */
.fmpe-banner{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:10px;height:32px;padding:0 6px 0 12px;border-radius:16px;background:#101828;color:#fff;font:600 12px/1 Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgba(16,24,40,.22);white-space:nowrap}
.fmpe-banner[hidden]{display:none}
.fmpe-banner small{color:#98a2b3;font-size:11px;font-weight:600}
.fmpe-banner button{height:22px;padding:0 10px;border:0;border-radius:11px;background:rgba(255,255,255,.16);color:#fff;font:700 11px/1 inherit;cursor:pointer}
.fmpe-banner button:hover{background:rgba(255,255,255,.26)}
/* spotlight (hovering a row, or a widget piece on the slide) */
.fmpe-spot{position:fixed;z-index:2147483000;pointer-events:none;border:1.5px solid var(--fmde-accent,#2563eb);border-radius:3px;box-shadow:0 0 0 3px color-mix(in srgb,var(--fmde-accent,#2563eb) 18%,transparent)}
.fmpe-spot[hidden]{display:none}
.fmpe-spot.part{border:1.5px dashed ${PART};box-shadow:none}
.fmpe-spot span{position:absolute;left:-1.5px;top:100%;margin-top:4px;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:5px;background:${PART};color:#fff;font:700 10px/1 Inter,ui-sans-serif,system-ui,sans-serif;white-space:nowrap}
.fmpe-spot span:empty{display:none}
.fmpe-spot span i{font-size:8px}
.fmpe-play{position:fixed;z-index:2147482990;overflow:hidden;border-radius:4px;box-shadow:0 0 0 2px var(--fmde-accent,#2563eb)}
.fmpe-play .fmdp{min-height:0}
.fmpe-present{position:fixed;inset:0;z-index:2147483200;background:#0b0d12}
/* shared panel vocabulary (Animate, Interactive, Layers) */
.fmpe-pane{display:flex;flex-direction:column;gap:14px;padding:12px;color:#111827;font-size:12.5px}
.fmpe-pane h4{margin:0;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6b7280}
.fmpe-pane h4 em{margin-left:auto;font-style:normal;font-weight:700;letter-spacing:0;text-transform:none;color:#98a2b3}
.fmpe-block{display:flex;flex-direction:column;gap:8px}
.fmpe-target{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 10px;border-radius:9px;background:#f4f5f8;font-weight:700}
.fmpe-target i{color:var(--fmde-accent);font-size:12px}
.fmpe-target span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmpe-target small{flex:none;color:#6b7280;font-weight:600;font-size:11px}
.fmpe-hint{margin:0;color:#6b7280;font-size:11.5px;line-height:1.45}
.fmpe-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.fmpe-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:56px;padding:8px 4px 7px;border:1px solid rgba(17,24,39,.1);border-radius:9px;background:#fff;color:#374151;font:600 11px/1.15 inherit;text-align:center;cursor:pointer;transition:border-color .12s ease,color .12s ease,background .12s ease}
.fmpe-tile i{font-size:14px;color:#6b7280}
.fmpe-tile:hover{border-color:var(--fmde-accent);color:var(--fmde-accent)}
.fmpe-tile:hover i,.fmpe-tile.on i{color:var(--fmde-accent)}
.fmpe-tile.on{border-color:var(--fmde-accent);background:var(--fmde-accent-soft);color:var(--fmde-accent);box-shadow:0 0 0 1px var(--fmde-accent)}
.fmpe-tile[data-kind=exit] i{transform:scaleX(-1)}
.fmpe-seg{display:flex;padding:2px;border-radius:8px;background:#eef0f3}
.fmpe-seg button{flex:1;min-width:0;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:#4b5563;font:600 11.5px/1 inherit;cursor:pointer;white-space:nowrap}
.fmpe-seg button.on{background:#fff;color:#111827;box-shadow:0 1px 2px rgba(16,24,40,.14)}
.fmpe-seg button:disabled{opacity:.45;cursor:default}
.fmpe-row{display:flex;align-items:center;gap:8px;min-height:28px}
.fmpe-row>label{flex:0 0 78px;color:#6b7280;font-weight:600;font-size:12px}
.fmpe-row>.fmpe-seg,.fmpe-row>select,.fmpe-row>.fmpe-num{flex:1;min-width:0}
.fmpe-pane select,.fmpe-pane input[type=text],.fmpe-pane input[type=number]{width:100%;height:28px;padding:0 8px;border:1px solid rgba(17,24,39,.12);border-radius:6px;background:#fff;color:#111827;font:inherit;font-size:12.5px}
.fmpe-pane select:focus,.fmpe-pane input:focus{outline:none;border-color:var(--fmde-accent);box-shadow:0 0 0 2px var(--fmde-accent-soft)}
.fmpe-num{position:relative;display:flex}
.fmpe-num input{padding-right:26px!important}
.fmpe-num::after{content:attr(data-unit);position:absolute;right:8px;top:50%;transform:translateY(-50%);color:#98a2b3;font-size:11px;pointer-events:none}
.fmpe-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fmpe-pair>div{display:flex;flex-direction:column;gap:4px}
.fmpe-pair label{color:#6b7280;font-weight:600;font-size:11px}
.fmpe-ibtn{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:#6b7280;font-size:11px;cursor:pointer}
.fmpe-ibtn:hover{background:rgba(17,24,39,.06);color:#111827}
.fmpe-ibtn.danger:hover{background:#fef3f2;color:#b42318}
.fmpe-ibtn.play{color:var(--fmde-accent)}
.fmpe-ibtn.play:hover{background:var(--fmde-accent-soft);color:var(--fmde-accent)}
.fmpe-card{display:flex;flex-direction:column;gap:8px;padding:9px;border:1px solid rgba(17,24,39,.1);border-radius:10px;background:#fff}
.fmpe-card.mine{border-color:color-mix(in srgb,var(--fmde-accent) 45%,transparent)}
.fmpe-card.dragover{box-shadow:0 -2px 0 var(--fmde-accent)}
.fmpe-card.on{border-color:var(--fmde-accent);box-shadow:0 0 0 1px var(--fmde-accent)}
.fmpe-card-head{display:flex;align-items:center;gap:6px}
.fmpe-card-head .grip{flex:none;width:12px;color:#c0c6cf;font-size:10px;cursor:grab;text-align:center}
.fmpe-card-head .num{flex:none;display:grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border:0;border-radius:10px;background:#eef0f3;color:#374151;font:800 10.5px/1 inherit;cursor:pointer;font-variant-numeric:tabular-nums}
.fmpe-card.on .num{background:var(--fmde-accent);color:var(--fmde-on-accent,#fff)}
.fmpe-card-head input[type=text]{flex:1;min-width:0;height:26px;border-color:transparent;background:transparent;padding:0 6px;font-weight:700}
.fmpe-card-head input[type=text]:hover{border-color:rgba(17,24,39,.12)}
.fmpe-card-head strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.fmpe-acts{display:flex;flex-direction:column;gap:1px;margin:0 -3px}
.fmpe-act{display:flex;align-items:center;gap:7px;min-height:26px;padding:0 3px 0 6px;border-radius:6px;cursor:pointer}
.fmpe-act:hover{background:rgba(17,24,39,.05)}
.fmpe-act.sel{background:var(--fmde-accent-soft)}
.fmpe-act>i{flex:none;width:12px;text-align:center;color:#98a2b3;font-size:10px}
.fmpe-act span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.fmpe-act small{flex:none;color:#6b7280;font-size:11px}
.fmpe-act .fmpe-ibtn{width:22px;height:22px;visibility:hidden}
.fmpe-act:hover .fmpe-ibtn{visibility:visible}
.fmpe-check{display:flex;align-items:center;gap:8px;color:#4b5563;font-size:12px;font-weight:600;cursor:pointer}
.fmpe-switch{flex:none;position:relative;width:30px;height:17px;padding:0;border:0;border-radius:9px;background:rgba(17,24,39,.2);cursor:pointer;transition:background .15s ease}
.fmpe-switch::after{content:'';position:absolute;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.3);transition:left .15s ease}
.fmpe-switch.on{background:var(--fmde-accent)}
.fmpe-switch.on::after{left:15px}
.fmpe-empty{padding:14px 12px;border:1px dashed rgba(17,24,39,.16);border-radius:10px;color:#6b7280;font-size:12px;line-height:1.45;text-align:center}
.fmpe-link{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--fmde-accent);font:700 12px/1.3 inherit;cursor:pointer}
.fmpe-link:hover{text-decoration:underline}
.fmpe-rule{height:1px;margin:0 -12px;background:rgba(17,24,39,.07)}
/* Design additions */
.fmpe-widgetbox{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid color-mix(in srgb,${PART} 32%,transparent);border-radius:10px;background:color-mix(in srgb,${PART} 5%,#fff)}
.fmpe-widgetbox-head{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px}
.fmpe-widgetbox-head i{color:${PART}}
.fmpe-widgetbox-head>span:not(.fmpe-badge){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmpe-badge{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:9px;background:${PART};color:#fff;font:700 10px/1 inherit;white-space:nowrap}
.fmpe-badge.soft{background:color-mix(in srgb,${PART} 14%,#fff);color:${PART}}
.fmpe-badge.warn{background:#fef0c7;color:#93370d}
.fmpe-badge i{font-size:8px}
.fmpe-widgetbox p{margin:0;color:#4b5563;font-size:11.5px;line-height:1.45}
.fmpe-sizeseg{display:flex;gap:6px;flex:1}
.fmpe-sizeseg button{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 4px 6px;border:1px solid rgba(17,24,39,.12);border-radius:8px;background:#fff;color:#4b5563;font:600 11px/1 inherit;cursor:pointer}
.fmpe-sizeseg button i{display:block;height:18px;border:1.5px solid currentColor;border-radius:2px}
.fmpe-sizeseg button.on{border-color:var(--fmde-accent);color:var(--fmde-accent);background:var(--fmde-accent-soft)}
/* Interactive rail tab */
.fmpe-rail{display:flex;flex-direction:column;gap:16px}
.fmpe-rail-head strong{display:block;font-size:14.5px;font-weight:900;letter-spacing:-.01em}
.fmpe-rail-head span{display:block;margin-top:3px;color:#667085;font-size:11.5px;line-height:1.4}
.fmpe-rail .fmpe-check{padding:8px 10px;border-radius:9px;background:#f4f5f8}
.fmpe-rail .fmpe-check span{flex:1}
.fmpe-group{display:flex;flex-direction:column;gap:8px}
.fmpe-group-head{display:flex;align-items:flex-start;gap:9px}
.fmpe-group-head>i{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:color-mix(in srgb,${PART} 12%,#fff);color:${PART};font-size:12px}
.fmpe-group-head strong{display:block;font-size:12.5px;font-weight:800}
.fmpe-group-head span{display:block;margin-top:1px;color:#667085;font-size:11px;line-height:1.35}
.fmpe-presets{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fmpe-preset{display:flex;flex-direction:column;gap:0;padding:0;border:1px solid #e4e7ec;border-radius:10px;background:#fff;overflow:hidden;cursor:pointer;text-align:left;transition:border-color .12s ease,box-shadow .12s ease}
.fmpe-preset:hover{border-color:${PART};box-shadow:0 4px 14px rgba(16,24,40,.08)}
.fmpe-preset.wide{grid-column:1 / -1}
.fmpe-preset .shot{position:relative;display:grid;place-items:center;height:104px;background:#f4f5f8;overflow:hidden;pointer-events:none}
.fmpe-preset.wide .shot{height:132px}
.fmpe-preset.tall .shot{height:150px}
.fmpe-preset .shot .fmdoc-page{box-shadow:none!important;background:transparent!important}
.fmpe-preset em{display:block;padding:7px 9px 8px;border-top:1px solid #eef0f4;font-style:normal;font-size:11px;font-weight:700;color:#344054;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmpe-btnsample{display:inline-grid;place-items:center;height:30px;padding:0 20px;border-radius:15px;font:700 11.5px/1 Inter,ui-sans-serif,system-ui,sans-serif}
.fmpe-btnsample.primary{background:var(--fm-primary,var(--fmde-accent,#2563eb));color:#fff;box-shadow:0 6px 14px rgba(16,24,40,.16)}
.fmpe-btnsample.plain{background:#fff;color:#101828;border:1px solid #e4e7ec}
/* Layers rail tab */
.fmpe-layers{display:flex;flex-direction:column;gap:1px}
.fmpe-layer{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 6px 0 8px;border:0;border-radius:7px;background:transparent;color:#344054;font:600 12px/1 inherit;text-align:left;cursor:pointer}
.fmpe-layer:hover{background:#f4f5f8}
.fmpe-layer.sel{background:var(--fmwe-tint);color:var(--fmwe-primary)}
.fmpe-layer>i{flex:none;width:14px;text-align:center;color:#98a2b3;font-size:11px}
.fmpe-layer.sel>i{color:inherit}
.fmpe-layer>span:not(.fmpe-badge):not(.mark){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmpe-layer.off>span:not(.fmpe-badge):not(.mark){opacity:.45;text-decoration:line-through}
.fmpe-layer .mark{flex:none;color:#98a2b3;font-size:9.5px}
/* menus */
.fmpe-menu{position:fixed;z-index:2147483100;width:270px;padding:6px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 18px 50px rgba(16,24,40,.2);font:13px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;color:#101828}
.fmpe-menu button{display:flex;align-items:flex-start;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.fmpe-menu button:hover{background:#f4f5f8}
.fmpe-menu button>i{flex:none;width:16px;margin-top:2px;text-align:center;color:#667085;font-size:12px}
.fmpe-menu strong{display:block;font-weight:700}
.fmpe-menu small{display:block;margin-top:2px;color:#667085;font-size:11.5px;line-height:1.35}
`;
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** A blank deck: one 16:9 slide with a white background. */
  function blankDocument() {
    const M = global.FMDocModel;
    const doc = M.createDocument({ kind: 'document' });
    doc.settings.paper = { size: 'slide' };
    doc.metadata = Object.assign({}, doc.metadata, { presentation: { version: 1 } });
    doc.assemblies = {};
    doc.pages = [blankSlide(doc, 'Slide 1')];
    return doc;
  }
  function backgroundNode(doc, color) {
    const M = global.FMDocModel;
    const paper = M.paperDimensions(doc);
    return M.createNode('shape', { name: 'Background', frame: { x: 0, y: 0, w: paper.w_pt, h: paper.h_pt, layout: 'absolute', z: 0 }, style: { fill: { type: 'solid', color } }, props: { shape: 'rect', corner_radius: 0 }, locks: { move: true, rotate: true } });
  }
  function blankSlide(doc, name) {
    return global.FMDocModel.createPage('custom', { name, children: [backgroundNode(doc, '#ffffff')] });
  }
  /** A slide's background is a full-bleed rectangle named "Background", first on the page. */
  function slideBackground(doc, page) {
    const paper = global.FMDocModel.paperDimensions(doc);
    return arr(obj(page).children).find((node) => node.type === 'shape' && node.name === 'Background' && Number(obj(node.frame).w) >= paper.w_pt - 1) || null;
  }
  /** Backgrounds stay put: a drag on the empty part of a slide must not slide its background away. */
  function pinBackgrounds(doc) {
    arr(doc.pages).forEach((page) => {
      const node = slideBackground(doc, page);
      if (node && !obj(node.locks).move) node.locks = Object.assign({}, obj(node.locks), { move: true, rotate: true });
    });
    return doc;
  }
  /** A rounded button with a label and a click action, like the ones a deck template uses. */
  function buttonNode(label, action, primary, frame) {
    const M = global.FMDocModel;
    const w = frame.w, h = 40;
    return M.createNode('frame', {
      name: label + ' button', frame: { x: frame.x, y: frame.y, w, h, layout: 'absolute', z: frame.z || 1 },
      style: Object.assign({ fill: { type: 'solid', color: primary ? 'var(--fm-primary)' : '#ffffff' }, corner_radius: 20 }, primary ? { shadow: { x: 0, y: 6, blur: 16, color: 'rgba(16,24,40,.18)' } } : { stroke: { color: '#e4e7ec', width_pt: 1 } }),
      props: { background: null, clip: false, overflow: 'visible', fmde_group: true, action },
      children: [M.createNode('text', { name: 'Label', frame: { x: 0, y: 12, w, h: 18, layout: 'absolute' }, props: { valign: 'top', line_height: 1.3, blocks: [{ id: M.generateId('blk'), type: 'paragraph', align: 'center', runs: [{ text: label, size_pt: 11.5, weight: 700, color: primary ? '#ffffff' : '#101828' }] }] } })]
    });
  }

  /**
   * A stand-in live state for a deck's widgets when the host has none: three
   * options for every selection the deck names, three add-ons, and totals.
   */
  function sampleState(doc) {
    const groups = new Set();
    Object.values(obj(obj(doc).assemblies)).forEach((entry) => {
      const source = obj(entry).config ? obj(entry).config.source : null;
      if (obj(source).kind === 'group' && text(source.id)) groups.add(text(source.id));
      if (typeof source === 'string' && source.startsWith('group:') && source.slice(6)) groups.add(source.slice(6));
    });
    const title = (id) => { const words = id.split(':').pop().replace(/[_-]+/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };
    const option = (id, name, cents, shade, selected) => ({ id, title: name, description: 'A short description of this option.', swatch: `linear-gradient(135deg,${shade[0]},${shade[1]})`, price_cents: cents, selected: !!selected });
    const shades = [['#cfd6de', '#9aa7b5'], ['#aab8c7', '#6f8094'], ['#7d8b9a', '#465a75']];
    return priceSample({
      groups: Array.from(groups).map((id) => ({ id, title: title(id), options: ['A', 'B', 'C'].map((letter, index) => option(`${id}_${letter.toLowerCase()}`, `Option ${letter}`, 240000 + index * 60000, shades[index], index === 1)) })),
      addons: ['A', 'B', 'C'].map((letter, index) => option(`addon_${letter.toLowerCase()}`, `Add-on ${letter}`, 60000 + index * 30000, shades[index], false)),
      base_cents: 400000, totals: {}
    });
  }
  /** Totals for a sample state from what is chosen in it. */
  function priceSample(state) {
    const chosen = arr(obj(state).groups).reduce((sum, group) => sum + (Number(obj(arr(group.options).find((entry) => entry.selected)).price_cents) || 0), 0);
    const extras = arr(obj(state).addons).filter((entry) => entry.selected).reduce((sum, entry) => sum + (Number(entry.price_cents) || 0), 0);
    const total = (Number(obj(state).base_cents) || 0) + chosen + extras;
    const deposit = Math.round(total * 0.3 / 100) * 100;
    state.totals = { subtotal_cents: total, tax_cents: 0, total_cents: total, deposit_cents: deposit, balance_cents: total - deposit };
    return state;
  }

  function mount(container, options) {
    if (!container) throw new Error('FMPresentationEditor.mount: container required');
    const M = global.FMDocModel;
    const Present = global.FMDocPresent;
    const Parts = () => global.FMDocParts || null;
    if (!M || !Present || !global.FMVisualEditor) throw new Error('FMPresentationEditor needs FMDocModel, FMDocPresent and FMVisualEditor');
    ensureStyles();
    const opts = obj(options);
    const roofing = opts.sampleState ? null : (global.FMRoofingPresentation || null);
    const sample = opts.sampleState ? clone(opts.sampleState) : (roofing ? roofing.priceSample(roofing.sampleState()) : sampleState(opts.document));
    const price = typeof opts.priceSample === 'function' ? opts.priceSample : (roofing ? roofing.priceSample : (opts.sampleState ? null : priceSample));

    const root = document.createElement('div');
    root.className = 'fmpe';
    container.appendChild(root);
    const spot = document.createElement('div');
    spot.className = 'fmpe-spot';
    spot.hidden = true;
    spot.innerHTML = '<span></span>';
    root.appendChild(spot);

    let visual = null;
    let destroyed = false;
    let savedJson = '';         // the document as last saved; anything else is unsaved work
    let stepPreview = null;      // number of steps played in the canvas preview, or null for "everything"
    let addTo = 'new';           // where a new animation goes: 'new' | 'last'
    const sampleOn = true;        // widgets on the canvas show the sample state, as they will when presenting
    let animHost = null;
    let railHost = null;         // { kind: 'interactive' | 'layers', host, api }
    let menu = null;
    let playing = null;
    let player = null;
    let canvasParts = null;
    let railThumbs = [];
    let queued = false;
    let banner = null;

    // ------------------------------------------------------------ document
    const getDoc = () => (visual ? visual.getDocument() : clone(obj(opts.document)));
    const pagesOf = (doc) => arr(obj(doc).pages);
    const currentId = () => (visual && visual.currentPage ? visual.currentPage() : '') || text(obj(pagesOf(opts.document)[0]).id);
    const currentPage = (doc) => pagesOf(doc).find((page) => page.id === currentId()) || pagesOf(doc)[0] || null;
    const pageIndex = (doc, id) => Math.max(0, pagesOf(doc).findIndex((page) => page.id === (id || currentId())));
    const nodeName = (node) => {
      if (text(obj(node).name)) return text(node.name);
      if (obj(node).type === 'text') {
        const value = arr(obj(arr(obj(node.props).blocks)[0]).runs).map((run) => run.text || '').join('').trim();
        if (value) return value.slice(0, 28);
      }
      return { text: 'Text', image: 'Image', shape: 'Shape', frame: 'Group', widget: 'Widget' }[obj(node).type] || 'Element';
    };
    const findNode = (doc, id) => obj(M.findNode(doc, id)).node || null;
    const toast = (message, ok) => {
      if (typeof obj(opts.chrome).toast === 'function') obj(opts.chrome).toast(message, ok !== false);
      else if (global.Portal && global.Portal.ui && global.Portal.ui.showToast) global.Portal.ui.showToast('Presentation', message, ok !== false);
    };
    const resolved = (doc) => {
      if (!opts.scope) return doc;
      try { const out = M.resolveBindings(doc, opts.scope); return out.document || out; } catch (e) { return doc; }
    };
    const apply = (commands, label) => {
      const list = arr(commands).filter(Boolean);
      if (!list.length || !visual) return { ok: true };
      return list.length === 1 ? visual.apply(list[0]) : visual.applyBatch(list, label || 'presentation');
    };
    const icon = (name) => `<i class="fas ${esc(name)}" aria-hidden="true"></i>`;

    // --------------------------------------------------------------- steps
    /** The slide's steps as the player reads them, safe to edit and write back. */
    const stepsOf = (page) => clone(Present.pageSteps(page));
    const writeSteps = (page, steps) => apply([{ type: 'page.set', page_id: page.id, prop: 'steps', value: steps.filter((step) => arr(step.actions).length) }]);
    const effect = (id) => Present.EFFECTS.find((entry) => entry.id === id) || null;
    const effectGroup = (entry) => (entry.kind === 'state' ? 'emphasis' : entry.kind);
    const stepLabel = (step, index) => text(step.name) || `Step ${index + 1}`;

    function setStepPreview(count) {
      stepPreview = count === null || count === undefined || count === stepPreview ? null : Number(count);
      decorateCanvas();
      syncChips();
      renderAnimate();
    }

    // ------------------------------------------------------------- canvas
    const stageEl = () => (visual ? visual.root.querySelector('.fmde-stage') : null);
    const pageEl = () => { const stage = stageEl(); return stage ? stage.querySelector('.fmdoc-page[data-fmde-current]') : null; };
    const nodeEl = (id) => { const host = pageEl(); return host ? host.querySelector(`[data-node-id="${attr(id)}"]`) : null; };

    /** After every canvas render: sample data in the widgets, then the step preview's ghosts. */
    function decorateCanvas() {
      const host = pageEl();
      if (!host || destroyed) return;
      const doc = getDoc();
      if (canvasParts) { try { canvasParts.destroy(); } catch (e) { /* gone with its DOM */ } canvasParts = null; }
      if (sampleOn && sample && Parts() && Object.keys(obj(doc.assemblies)).length) {
        try { canvasParts = Parts().attach(host, { document: doc, state: sample, readonly: true }); } catch (e) { canvasParts = null; }
      }
      host.querySelectorAll('[data-fmpe-ghost],[data-fmpe-dim],[data-fmpe-hl]').forEach((el) => { el.removeAttribute('data-fmpe-ghost'); el.removeAttribute('data-fmpe-dim'); el.removeAttribute('data-fmpe-hl'); });
      const page = currentPage(doc);
      const steps = page ? Present.pageSteps(page) : [];
      if (stepPreview !== null && stepPreview > steps.length) stepPreview = null;
      if (banner) {
        banner.hidden = stepPreview === null;
        if (stepPreview !== null) {
          const label = stepPreview === 0 ? 'Before any step' : `After step ${stepPreview}${text(steps[stepPreview - 1].name) ? ' \u00b7 ' + esc(steps[stepPreview - 1].name) : ''}`;
          banner.innerHTML = `<span>${label}</span><small>Hidden elements are ghosted</small><button type="button" data-fmpe-preview-off>Show everything</button>`;
        }
      }
      if (stepPreview === null || !page) return;
      for (const [id, value] of Object.entries(Present.stateAtStep(page, stepPreview))) {
        const el = host.querySelector(`[data-node-id="${attr(id)}"]`);
        if (!el) continue;
        el.toggleAttribute('data-fmpe-ghost', !value.visible);
        el.toggleAttribute('data-fmpe-dim', value.visible && value.dim);
        el.toggleAttribute('data-fmpe-hl', value.visible && value.highlight);
      }
    }

    function spotlight(el, label, part) {
      const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect || !rect.width) { spot.hidden = true; return; }
      spot.hidden = false;
      spot.classList.toggle('part', !!part);
      spot.style.left = rect.left + 'px'; spot.style.top = rect.top + 'px';
      spot.style.width = rect.width + 'px'; spot.style.height = rect.height + 'px';
      spot.firstChild.innerHTML = label || '';
    }
    const partLabel = (doc, node) => {
      const part = M.nodePart(node);
      if (!part) return null;
      const entry = obj(obj(doc.assemblies)[part.assembly]);
      const type = Parts() && Parts().get ? Parts().get(entry.type) : null;
      return { part, entry, type, label: text(obj(obj(type).roles)[part.role]) || part.role.replace(/[._]+/g, ' '), required: !!M.partRemovalBlock(doc, [node.id]) };
    };
    /** Pieces of a widget announce themselves under the pointer, before they are selected. */
    let hoverFrame = 0;
    let hoverDoc = null;
    function onCanvasMove(event) {
      if (event.buttons || hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const host = pageEl();
        if (!host || playing) { spot.hidden = true; return; }
        const el = document.elementsFromPoint(event.clientX, event.clientY).find((entry) => host.contains(entry) && entry.closest('[data-part-assembly]'));
        const partEl = el ? el.closest('[data-part-assembly]') : null;
        const id = partEl ? partEl.getAttribute('data-node-id') : '';
        if (!id || visual.selection().includes(id)) { spot.hidden = true; return; }
        hoverDoc = hoverDoc || getDoc();
        const info = partLabel(hoverDoc, findNode(hoverDoc, id) || {});
        if (!info) { spot.hidden = true; return; }
        spotlight(partEl, (info.required ? icon('fa-lock') : '') + esc(info.label + (info.required ? ' \u00b7 required' : '')), true);
      });
    }

    // ---------------------------------------------------------- playback
    function stopPlaying() {
      if (!playing) return;
      clearTimeout(playing.timer);
      try { playing.player.destroy(); } catch (e) { /* already gone */ }
      playing.layer.remove();
      playing = null;
    }
    /** Play something in place, over the slide: the real player on a cut-down copy of the deck. */
    function playInPlace(build) {
      stopPlaying();
      const host = pageEl();
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const doc = getDoc();
      const plan = build(doc);
      if (!plan) return;
      const layer = document.createElement('div');
      layer.className = 'fmpe-play';
      layer.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      root.appendChild(layer);
      spot.hidden = true;
      const deck = Object.assign({}, doc, { pages: plan.pages });
      const instance = Present.mount(layer, {
        document: resolved(deck), theme: opts.theme, themeContext: opts.themeContext, mediaUrl: obj(opts.media).url,
        controls: false, autofocus: false, start: plan.start, live: sample ? { state: clone(sample), readonly: true } : undefined
      });
      playing = { layer, player: instance, timer: 0 };
      const mine = playing;
      Promise.resolve(instance.ready()).then(() => {
        if (playing !== mine) return;
        mine.timer = setTimeout(() => {
          if (playing !== mine) return;
          instance.next();
          mine.timer = setTimeout(() => { if (playing === mine) stopPlaying(); }, plan.ms + 700);
        }, 160);
      });
    }
    const manual = (steps) => steps.map((step) => Object.assign({}, step, { auto: false }));
    function playStep(index) {
      playInPlace((doc) => {
        const page = currentPage(doc);
        const steps = page ? stepsOf(page) : [];
        if (!steps[index]) return null;
        const ms = Math.max(0, ...steps[index].actions.map((action) => (Number(action.duration_ms) || 500) + (Number(action.delay_ms) || 0)));
        return { pages: [Object.assign({}, page, { steps: manual(steps.slice(0, index + 1)), transition: null })], start: { page: 0, step: index }, ms };
      });
    }
    function playTransition() {
      playInPlace((doc) => {
        const page = currentPage(doc);
        const index = pageIndex(doc);
        if (!page) return null;
        if (index === 0) { toast('The first slide has nothing to arrive from. Its transition plays when you loop back to it.', true); return null; }
        const before = pagesOf(doc)[index - 1];
        const steps = manual(stepsOf(before));
        return { pages: [Object.assign({}, before, { steps }), Object.assign({}, page, { steps: [] })], start: { page: 0, step: steps.length }, ms: Present.pageTransition(page).duration_ms };
      });
    }

    function present() {
      if (player) return;
      stopPlaying();
      closeMenu();
      const doc = getDoc();
      const overlay = document.createElement('div');
      overlay.className = 'fmpe-present';
      overlay.setAttribute('data-fmpe-present', '');
      document.body.appendChild(overlay);
      let wentFull = false;
      const close = () => {
        if (!player) return;
        const at = player.instance.position();
        document.removeEventListener('fullscreenchange', onFull);
        try { player.instance.destroy(); } catch (e) { /* already gone */ }
        if (document.fullscreenElement === overlay) document.exitFullscreen?.().catch(() => {});
        overlay.remove();
        player = null;
        // Back in the editor on the slide that was showing.
        const page = pagesOf(getDoc())[at.page];
        if (page && page.id !== currentId()) visual.showPage(page.id);
        visual.root.querySelector('.fmde-root')?.focus({ preventScroll: true });
      };
      const onFull = () => { if (document.fullscreenElement === overlay) wentFull = true; else if (wentFull) close(); };
      const instance = Present.mount(overlay, {
        document: resolved(doc), theme: opts.theme, themeContext: opts.themeContext, mediaUrl: obj(opts.media).url,
        start: { page: pageIndex(doc), step: 0 },
        live: sample ? { state: clone(sample), onInput: () => (price ? price(clone(instance.state())) : undefined) } : undefined,
        onAction: (name) => { if (typeof opts.onAction === 'function') opts.onAction(name); },
        onExit: close
      });
      player = { instance, overlay, close };
      document.addEventListener('fullscreenchange', onFull);
      try { overlay.requestFullscreen?.().catch(() => {}); } catch (e) { /* stays a full-window overlay */ }
    }

    // --------------------------------------------------------------- menus
    function closeMenu() {
      if (!menu) return;
      document.removeEventListener('pointerdown', menu.outside, true);
      document.removeEventListener('keydown', menu.key, true);
      menu.el.remove();
      menu = null;
    }
    function openMenu(anchor, items) {
      closeMenu();
      const el = document.createElement('div');
      el.className = 'fmpe-menu';
      el.setAttribute('role', 'menu');
      el.innerHTML = items.map((item, index) => `<button type="button" role="menuitem" data-fmpe-menu="${esc(item.id || index)}">${icon(item.icon)}<span><strong>${esc(item.label)}</strong>${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</span></button>`).join('');
      document.body.appendChild(el);
      const rect = anchor.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      el.style.left = Math.max(8, Math.min(global.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2)) + 'px';
      el.style.top = (rect.top - box.height - 8 > 8 ? rect.top - box.height - 8 : rect.bottom + 8) + 'px';
      el.querySelectorAll('button').forEach((button, index) => button.addEventListener('click', () => { closeMenu(); items[index].run(); }));
      menu = {
        el,
        outside: (event) => { if (!el.contains(event.target)) closeMenu(); },
        key: (event) => { if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); } }
      };
      document.addEventListener('pointerdown', menu.outside, true);
      document.addEventListener('keydown', menu.key, true);
    }

    // -------------------------------------------------------------- slides
    function addBlank(afterId) {
      const doc = getDoc();
      const after = afterId ? M.findPage(doc, afterId) : M.findPage(doc, currentId());
      const page = blankSlide(doc, `Slide ${pagesOf(doc).length + 1}`);
      const result = apply([{ type: 'page.insert', page, index: after ? after.index + 1 : undefined }]);
      if (result && result.ok === false) { toast('Could not add a slide here.', false); return; }
      visual.showPage(page.id);
    }
    /** A copy with its own node ids: steps follow their nodes, and its widgets become widgets of their own. */
    function copyOf(doc, source) {
      const page = clone(source);
      page.id = M.generateId('pg');
      page.name = `${text(source.name) || 'Slide'} copy`;
      page.children = M.reassignIds(arr(source.children));
      const ids = new Map();
      const pair = (before, after) => arr(before).forEach((node, index) => { const twin = after[index]; if (!twin) return; ids.set(node.id, twin.id); pair(node.children, arr(twin.children)); });
      pair(source.children, page.children);
      page.steps = arr(page.steps).map((step) => Object.assign({}, step, { id: M.generateId('step'), actions: arr(step.actions).map((action) => Object.assign({}, action, { node: ids.get(action.node) || action.node })) }));
      const assemblies = Object.assign({}, obj(doc.assemblies));
      const renamed = new Map();
      (function visit(nodes) {
        arr(nodes).forEach((node) => {
          const part = M.nodePart(node);
          if (part && assemblies[part.assembly]) {
            if (!renamed.has(part.assembly)) { renamed.set(part.assembly, M.generateId('asm')); assemblies[renamed.get(part.assembly)] = clone(assemblies[part.assembly]); }
            node.props.part = Object.assign({}, node.props.part, { assembly: renamed.get(part.assembly) });
          }
          visit(node.children);
        });
      })(page.children);
      return { page, assemblies: renamed.size ? assemblies : null };
    }
    function insertCopy(afterId, source) {
      const doc = getDoc();
      const after = M.findPage(doc, afterId);
      const copy = copyOf(doc, source);
      const result = apply([copy.assemblies ? { type: 'doc.set', prop: 'assemblies', value: copy.assemblies } : null, { type: 'page.insert', page: copy.page, index: after ? after.index + 1 : undefined }], 'duplicate-slide');
      if (result && result.ok === false) { toast('Could not duplicate this slide.', false); return; }
      visual.showPage(copy.page.id);
    }

    const pages = {
      list() {
        const doc = getDoc();
        return pagesOf(doc).map((page, index) => ({ id: text(page.id) || String(index), title: text(page.name) || `Slide ${index + 1}`, definition: Object.assign({}, doc, { pages: [page] }) }));
      },
      current: currentId,
      select(id) { if (visual && id !== currentId()) visual.showPage(id); },
      add(afterId, context) {
        const anchor = obj(context).anchor;
        if (!anchor) { addBlank(afterId); return; }
        openMenu(anchor, [
          { id: 'blank', icon: 'fa-plus', label: 'Blank slide', hint: 'An empty slide after this one.', run: () => addBlank() },
          { id: 'duplicate', icon: 'fa-clone', label: 'Duplicate this slide', hint: 'Then move things: Match & move animates the difference.', run: () => pages.duplicate(currentId()) }
        ]);
      },
      rename(id, title) { if (text(title)) apply([{ type: 'page.set', page_id: id, prop: 'name', value: text(title) }]); },
      copy(id) { const found = M.findPage(getDoc(), id); return found ? clone(found.page) : null; },
      paste(afterId, copied) { if (copied) insertCopy(afterId, copied); },
      duplicate(id) { const found = M.findPage(getDoc(), id); if (found) insertCopy(id, found.page); },
      remove(id) {
        const doc = getDoc();
        const found = M.findPage(doc, id);
        if (!found) return;
        if (pagesOf(doc).length < 2) { toast('A presentation needs at least one slide.', false); return; }
        const next = pagesOf(doc)[found.index + 1] || pagesOf(doc)[found.index - 1];
        // Widgets that only lived on this slide go with it.
        const left = M.pruneAssemblies(Object.assign({}, clone(doc), { pages: pagesOf(doc).filter((page) => page.id !== id) })).assemblies;
        const pruned = Object.keys(obj(left)).length !== Object.keys(obj(doc.assemblies)).length;
        if (id === currentId()) visual.showPage(next.id);
        apply([{ type: 'page.remove', page_id: id }, pruned ? { type: 'doc.set', prop: 'assemblies', value: left } : null], 'delete-slide');
      },
      move(id, targetId, after) {
        const order = pagesOf(getDoc()).map((page) => page.id).filter((entry) => entry !== id);
        const at = order.indexOf(targetId);
        if (at < 0) return;
        apply([{ type: 'page.move', page_id: id, index: at + (after ? 1 : 0) }]);
      },
      /** The strip card: slide number, its transition, and its steps as chips. */
      decorate(card, entry) {
        const page = obj(pagesOf(entry.definition)[0]);
        const doc = entry.definition;
        const index = pageIndex(getDocCached(), entry.id);
        const label = card.querySelector('.label');
        if (label) label.innerHTML = `<b>${index + 1}</b><span>${esc(entry.title)}</span>`;
        const transition = Present.pageTransition(page);
        if (transition.type !== 'none' && index > 0) {
          const mark = document.createElement('span');
          mark.className = 'fmpe-tmark';
          mark.title = (Present.TRANSITIONS.find((item) => item.id === transition.type) || {}).label || '';
          mark.innerHTML = icon(TRANSITION_ICONS[transition.type] || 'fa-wand-magic-sparkles');
          card.appendChild(mark);
        }
        const steps = Present.pageSteps(page);
        const row = document.createElement('div');
        row.className = 'fmpe-chips';
        row.setAttribute('data-fmpe-chips', entry.id);
        if (entry.id === currentId()) requestAnimationFrame(() => { if (card.isConnected) card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
        if (entry.id === currentId() && steps.length) {
          const shown = steps.slice(0, 5);
          row.innerHTML = `<button type="button" class="fmpe-chip" data-fmpe-step="0" title="Before any step">${icon('fa-play')}</button>`
            + shown.map((step, at) => `<button type="button" class="fmpe-chip${step.auto ? ' auto' : ''}" data-fmpe-step="${at + 1}" title="${esc(stepLabel(step, at) + (step.auto ? ' \u00b7 plays automatically' : ''))}">${at + 1}</button>`).join('')
            + (steps.length > shown.length ? `<span class="more">+${steps.length - shown.length}</span>` : '');
          row.addEventListener('click', (event) => {
            const chip = event.target.closest('[data-fmpe-step]');
            if (!chip) return;
            event.stopPropagation();
            setStepPreview(Number(chip.dataset.fmpeStep));
          });
        } else {
          row.innerHTML = steps.slice(0, 8).map(() => '<span class="dot"></span>').join('');
          if (steps.length) row.title = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
        }
        card.appendChild(row);
        // Thumbnails show the same sample data as the slide.
        if (sampleOn && sample && Parts() && Object.keys(obj(doc.assemblies)).length) {
          const stage = card.querySelector('.stage');
          setTimeout(() => { if (stage && stage.isConnected) { try { Parts().attach(stage, { document: doc, state: sample, readonly: true }); } catch (e) { /* thumbnail only */ } } }, 120);
        }
        syncChips();
      }
    };
    // One strip render decorates every card; they share one document read.
    let cachedDoc = null;
    function getDocCached() {
      if (!cachedDoc) { cachedDoc = getDoc(); Promise.resolve().then(() => { cachedDoc = null; }); }
      return cachedDoc;
    }
    function syncChips() {
      if (!visual) return;
      visual.root.querySelectorAll('.fmpe-chip').forEach((chip) => chip.classList.toggle('on', stepPreview !== null && Number(chip.dataset.fmpeStep) === stepPreview));
    }

    // ------------------------------------------------------ Animate panel
    function tiles(items, active, dataKey, iconFor) {
      return `<div class="fmpe-tiles">${items.map((item) => `<button type="button" class="fmpe-tile${item.id === active ? ' on' : ''}" data-${dataKey}="${esc(item.id)}" data-kind="${esc(item.kind || '')}">${icon(iconFor(item))}<span>${esc(item.label)}</span></button>`).join('')}</div>`;
    }
    const directions = (value, dataKey) => `<div class="fmpe-seg" role="group" aria-label="Direction">${Present.DIRECTIONS.map((dir) => `<button type="button" class="${dir === value ? 'on' : ''}" data-${dataKey}="${dir}" title="From the ${dir === 'up' ? 'bottom' : dir === 'down' ? 'top' : dir === 'left' ? 'right' : 'left'}, moving ${dir}">${icon(DIRECTION_ICONS[dir])}</button>`).join('')}</div>`;
    const number = (key, value, placeholder, unit) => `<span class="fmpe-num" data-unit="${unit}"><input type="number" min="0" max="10000" step="50" data-fmpe-key="${esc(key)}" value="${value === undefined || value === null ? '' : esc(value)}" placeholder="${esc(placeholder)}"></span>`;

    function renderAnimate() {
      if (!animHost || destroyed || !visual) return;
      const focusKey = animHost.contains(document.activeElement) ? document.activeElement.getAttribute('data-fmpe-key') : '';
      const doc = getDoc();
      const page = currentPage(doc);
      if (!page) { animHost.innerHTML = ''; return; }
      const steps = Present.pageSteps(page);
      const selection = visual.selection();
      const node = selection.length === 1 ? findNode(doc, selection[0]) : null;
      const names = new Map();
      M.walkNodes(Object.assign({}, doc, { pages: [page] }), (entry) => { names.set(entry.id, nodeName(entry)); });
      let html = '';

      if (node) {
        const mine = [];
        steps.forEach((step, s) => step.actions.forEach((action, a) => { if (action.node === node.id) mine.push({ step, s, a, action }); }));
        html += `<div class="fmpe-block"><h4>Animate</h4><div class="fmpe-target">${icon(NODE_ICONS[node.type] || 'fa-square')}<span>${esc(nodeName(node))}</span><small>${mine.length ? `${mine.length} animation${mine.length === 1 ? '' : 's'}` : 'Not animated'}</small></div>`;
        html += mine.map((entry) => {
          const def = effect(entry.action.effect) || {};
          const key = `${entry.s}:${entry.a}`;
          return `<div class="fmpe-card mine" data-fmpe-mine="${key}">
            <div class="fmpe-card-head">${icon(EFFECT_ICONS[def.id] || 'fa-wand-magic-sparkles')}<strong>${esc(def.label || entry.action.effect)}</strong><button type="button" class="fmpe-ibtn play" data-fmpe-play="${entry.s}" title="Play this step">${icon('fa-play')}</button><button type="button" class="fmpe-ibtn danger" data-fmpe-remove="${key}" title="Remove animation">${icon('fa-trash')}</button></div>
            <div class="fmpe-row"><label>Effect</label><select data-fmpe-effect="${key}" data-fmpe-key="effect:${key}">${EFFECT_GROUPS.map((group) => `<optgroup label="${group.label}">${Present.EFFECTS.filter((item) => effectGroup(item) === group.kind).map((item) => `<option value="${esc(item.id)}"${item.id === def.id ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}</optgroup>`).join('')}</select></div>
            <div class="fmpe-row"><label>Plays on</label><select data-fmpe-move="${key}" data-fmpe-key="move:${key}">${steps.map((step, at) => `<option value="${at}"${at === entry.s ? ' selected' : ''}>${esc(`${at + 1} \u00b7 ${stepLabel(step, at)}`)}</option>`).join('')}<option value="new">A new step</option></select></div>
            ${def.directional ? `<div class="fmpe-row"><label>Direction</label>${directions(entry.action.direction || (def.id === 'wipe' ? 'right' : 'left'), `fmpe-dir="${key}" data-dir`)}</div>` : ''}
            <div class="fmpe-pair"><div><label>Duration</label>${number(`duration:${key}`, entry.action.duration_ms, '500', 'ms')}</div><div><label>Delay</label>${number(`delay:${key}`, entry.action.delay_ms, '0', 'ms')}</div></div>
          </div>`;
        }).join('');
        html += `</div><div class="fmpe-block"><h4>Add animation</h4>
          <div class="fmpe-seg" role="group" aria-label="Which step"><button type="button" class="${addTo === 'new' || !steps.length ? 'on' : ''}" data-fmpe-addto="new">New step</button><button type="button" class="${addTo === 'last' && steps.length ? 'on' : ''}" data-fmpe-addto="last" ${steps.length ? '' : 'disabled'}>With previous step</button></div>
          ${EFFECT_GROUPS.map((group) => `<h4>${group.label}<em>${group.hint}</em></h4>${tiles(Present.EFFECTS.filter((item) => effectGroup(item) === group.kind), '', 'fmpe-add', (item) => EFFECT_ICONS[item.id] || 'fa-wand-magic-sparkles')}`).join('')}
        </div>`;
      } else {
        const transition = Present.pageTransition(page);
        const def = Present.TRANSITIONS.find((item) => item.id === transition.type) || {};
        html += `<div class="fmpe-block"><h4>Slide transition<em>How this slide arrives</em></h4>
          ${tiles(Present.TRANSITIONS, transition.type, 'fmpe-transition', (item) => TRANSITION_ICONS[item.id] || 'fa-wand-magic-sparkles')}
          ${transition.type === 'morph' ? '<p class="fmpe-hint">Elements with the same name on the previous slide glide to their new place; everything else fades. Duplicate a slide, then move things.</p>' : ''}
          ${def.directional ? `<div class="fmpe-row"><label>Direction</label>${directions(transition.direction, 'fmpe-tdir')}</div>` : ''}
          ${transition.type !== 'none' ? `<div class="fmpe-row"><label>Duration</label>${number('tduration', obj(page.transition).duration_ms, String(transition.duration_ms), 'ms')}<button type="button" class="fmpe-ibtn play" data-fmpe-play-transition title="Play the transition">${icon('fa-play')}</button></div>` : ''}
        </div>`;
      }

      html += `<div class="fmpe-rule"></div><div class="fmpe-block"><h4>Steps<em>${steps.length ? 'One click each, in order' : ''}</em></h4>`;
      html += steps.length ? steps.map((step, s) => `<div class="fmpe-card${stepPreview === s + 1 ? ' on' : ''}" data-fmpe-stepcard="${s}" draggable="true">
          <div class="fmpe-card-head"><span class="grip" title="Drag to reorder">${icon('fa-grip-vertical')}</span><button type="button" class="num" data-fmpe-preview="${s + 1}" title="Show the slide after this step">${s + 1}</button><input type="text" data-fmpe-name="${s}" data-fmpe-key="name:${s}" value="${esc(step.name)}" placeholder="Step ${s + 1}" aria-label="Step name"><button type="button" class="fmpe-ibtn play" data-fmpe-play="${s}" title="Play this step">${icon('fa-play')}</button><button type="button" class="fmpe-ibtn danger" data-fmpe-delstep="${s}" title="Delete step">${icon('fa-trash')}</button></div>
          <div class="fmpe-acts">${step.actions.map((action, a) => `<div class="fmpe-act${node && action.node === node.id ? ' sel' : ''}" data-fmpe-act="${esc(action.node)}">${icon(EFFECT_ICONS[action.effect] || 'fa-wand-magic-sparkles')}<span>${esc(names.get(action.node) || 'Missing element')}</span><small>${esc((effect(action.effect) || {}).label || action.effect)}</small><button type="button" class="fmpe-ibtn danger" data-fmpe-remove="${s}:${a}" title="Remove">${icon('fa-xmark')}</button></div>`).join('')}</div>
          <label class="fmpe-check"><button type="button" class="fmpe-switch${step.auto ? ' on' : ''}" role="switch" aria-checked="${step.auto ? 'true' : 'false'}" data-fmpe-auto="${s}"></button><span>Plays automatically</span></label>
        </div>`).join('')
        : `<div class="fmpe-empty">${node ? 'Pick an effect above. The element appears, leaves or stands out on a click while presenting.' : 'This slide shows everything at once. Select an element to animate it.'}</div>`;
      html += '</div>';
      animHost.innerHTML = `<div class="fmpe-pane" data-fmpe-animate>${html}</div>`;
      if (focusKey) animHost.querySelector(`[data-fmpe-key="${attr(focusKey)}"]`)?.focus({ preventScroll: true });
    }

    function wireAnimate(host) {
      const context = () => { const doc = getDoc(); const page = currentPage(doc); return { doc, page, steps: page ? stepsOf(page) : [] }; };
      const at = (key) => String(key).split(':').map(Number);
      const edit = (fn) => { const ctx = context(); if (!ctx.page) return; if (fn(ctx.steps, ctx) !== false) writeSteps(ctx.page, ctx.steps); };
      const setTransition = (patch) => {
        const ctx = context();
        if (!ctx.page) return;
        const next = Object.assign({}, obj(ctx.page.transition), patch);
        if (next.duration_ms === null) delete next.duration_ms;
        apply([{ type: 'page.set', page_id: ctx.page.id, prop: 'transition', value: next.type && next.type !== 'none' ? next : null }]);
      };
      host.addEventListener('click', (event) => {
        const hit = (name) => event.target.closest(`[data-fmpe-${name}]`);
        let el;
        if ((el = hit('addto'))) { addTo = el.dataset.fmpeAddto; renderAnimate(); }
        else if ((el = hit('add'))) {
          const id = visual.selection()[0];
          const def = effect(el.dataset.fmpeAdd);
          if (!id || !def) return;
          stepPreview = null;
          edit((steps) => {
            const action = Object.assign({ node: id, effect: def.id }, def.directional ? { direction: def.id === 'wipe' ? 'right' : 'left' } : {});
            if (addTo === 'last' && steps.length) steps[steps.length - 1].actions.push(action);
            else steps.push({ id: M.generateId('step'), name: '', auto: false, actions: [action] });
          });
        }
        else if ((el = hit('remove'))) { const [s, a] = at(el.dataset.fmpeRemove); event.stopPropagation(); edit((steps) => { if (steps[s]) steps[s].actions.splice(a, 1); }); }
        else if ((el = hit('dir'))) { const [s, a] = at(el.dataset.fmpeDir); edit((steps) => { if (steps[s] && steps[s].actions[a]) steps[s].actions[a].direction = el.dataset.dir; }); }
        else if ((el = hit('play-transition'))) playTransition();
        else if ((el = hit('play'))) playStep(Number(el.dataset.fmpePlay));
        else if ((el = hit('preview'))) setStepPreview(Number(el.dataset.fmpePreview));
        else if ((el = hit('delstep'))) edit((steps) => { steps.splice(Number(el.dataset.fmpeDelstep), 1); });
        else if ((el = hit('auto'))) edit((steps) => { const step = steps[Number(el.dataset.fmpeAuto)]; if (step) step.auto = !step.auto; });
        else if ((el = hit('transition'))) setTransition({ type: el.dataset.fmpeTransition });
        else if ((el = hit('tdir'))) setTransition({ direction: el.dataset.fmpeTdir });
        else if ((el = hit('act'))) visual.select([el.dataset.fmpeAct]);
      });
      host.addEventListener('change', (event) => {
        const el = event.target;
        const key = text(el.getAttribute('data-fmpe-key'));
        const value = el.value;
        const ms = () => (value === '' ? undefined : Math.max(0, Math.min(10000, Number(value) || 0)));
        if (el.dataset.fmpeEffect) { const [s, a] = at(el.dataset.fmpeEffect); edit((steps) => { const action = steps[s] && steps[s].actions[a]; if (!action) return false; action.effect = value; if (!obj(effect(value)).directional) delete action.direction; return true; }); }
        else if (el.dataset.fmpeMove) {
          const [s, a] = at(el.dataset.fmpeMove);
          edit((steps) => {
            const action = steps[s] && steps[s].actions.splice(a, 1)[0];
            if (!action) return false;
            if (value === 'new') steps.push({ id: M.generateId('step'), name: '', auto: false, actions: [action] });
            else steps[Number(value)].actions.push(action);
            return true;
          });
        }
        else if (el.dataset.fmpeName !== undefined) edit((steps) => { const step = steps[Number(el.dataset.fmpeName)]; if (step) step.name = text(value); });
        else if (key === 'tduration') setTransition({ duration_ms: ms() === undefined ? null : ms() });
        else if (key.startsWith('duration:') || key.startsWith('delay:')) {
          const [s, a] = at(key.slice(key.indexOf(':') + 1));
          const prop = key.startsWith('duration:') ? 'duration_ms' : 'delay_ms';
          edit((steps) => { const action = steps[s] && steps[s].actions[a]; if (!action) return false; if (ms() === undefined) delete action[prop]; else action[prop] = ms(); return true; });
        }
      });
      // Keys typed in a field are the field's, not the canvas's shortcuts.
      host.addEventListener('keydown', (event) => { if (event.target.closest('input,select')) { event.stopPropagation(); if (event.key === 'Enter') event.target.blur(); } });
      host.addEventListener('pointerover', (event) => {
        const row = event.target.closest('[data-fmpe-act]');
        if (row) spotlight(nodeEl(row.dataset.fmpeAct), '', false);
      });
      host.addEventListener('pointerout', (event) => { if (event.target.closest('[data-fmpe-act]')) spot.hidden = true; });
      let dragStep = null;
      host.addEventListener('dragstart', (event) => {
        const card = event.target.closest?.('[data-fmpe-stepcard]');
        if (!card || event.target.closest('input')) { event.preventDefault(); return; }
        dragStep = Number(card.dataset.fmpeStepcard);
        try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(dragStep)); } catch (e) { /* noop */ }
      });
      host.addEventListener('dragover', (event) => {
        const card = event.target.closest?.('[data-fmpe-stepcard]');
        if (dragStep === null || !card) return;
        event.preventDefault();
        host.querySelectorAll('.fmpe-card.dragover').forEach((el) => el.classList.remove('dragover'));
        if (Number(card.dataset.fmpeStepcard) !== dragStep) card.classList.add('dragover');
      });
      host.addEventListener('dragend', () => { dragStep = null; host.querySelectorAll('.fmpe-card.dragover').forEach((el) => el.classList.remove('dragover')); });
      host.addEventListener('drop', (event) => {
        const card = event.target.closest?.('[data-fmpe-stepcard]');
        if (dragStep === null || !card) return;
        event.preventDefault();
        const from = dragStep, to = Number(card.dataset.fmpeStepcard);
        dragStep = null;
        if (from === to) return;
        stepPreview = null;
        edit((steps) => { steps.splice(to, 0, steps.splice(from, 1)[0]); });
      });
    }

    // --------------------------------------------------- Design additions
    /** The widget a node belongs to: as one of its pieces, or as the group that holds them. */
    function assemblyOf(doc, node) {
      const part = M.nodePart(node);
      if (part) return part.assembly;
      const found = new Set();
      (function visit(nodes) { arr(nodes).forEach((entry) => { const inner = M.nodePart(entry); if (inner) found.add(inner.assembly); visit(entry.children); }); })(node.children);
      return found.size === 1 ? Array.from(found)[0] : '';
    }
    /** The smallest group that holds every piece of a widget, else the pieces themselves. */
    function wholeWidget(doc, assemblyId) {
      const parts = M.assemblyParts(doc, assemblyId, []);
      const chain = (id) => { const out = []; for (let found = M.findNode(doc, id); found && found.parent; found = M.findNode(doc, found.parent.id)) out.push(found.parent.id); return out; };
      let common = null;
      parts.forEach((part) => { const up = chain(part.node.id); common = common === null ? up : common.filter((id) => up.includes(id)); });
      return common && common.length ? [common[0]] : parts.map((part) => part.node.id);
    }
    function sourceOptions(type, config) {
      const groups = arr(obj(sample).groups).map((group) => ({ id: text(group.id), title: text(group.title) || text(group.id) }));
      if (type === 'choice_selection') {
        const source = obj(config.source);
        const value = source.kind === 'addons' ? 'addons' : 'group:' + text(source.id);
        const list = [['addons', 'Add-ons (pick any)']].concat(groups.map((group) => ['group:' + group.id, group.title]));
        if (!list.some((entry) => entry[0] === value)) list.push([value, text(source.id) ? `Group \u201c${source.id}\u201d` : 'Choose a selection\u2026']);
        return { label: 'Shows', value, list, write: (next) => (next === 'addons' ? { kind: 'addons' } : { kind: 'group', id: next.slice(6) }), groupId: source.kind === 'addons' ? null : text(source.id) };
      }
      if (type === 'option_compare') {
        const source = obj(config.source);
        const list = groups.map((group) => ['group:' + group.id, group.title]);
        const value = 'group:' + text(source.id);
        if (!list.some((entry) => entry[0] === value)) list.push([value, text(source.id) ? `Group “${source.id}”` : 'Choose a selection…']);
        return { label: 'Compares', value, list, write: (next) => ({ kind: 'group', id: next.slice(6) }), groupId: text(source.id) };
      }
      if (type === 'price_display') {
        const value = text(config.source) || 'total';
        const list = [['total', 'Total'], ['subtotal', 'Subtotal'], ['deposit', 'Deposit (due at signing)'], ['balance', 'Balance']].concat(groups.map((group) => ['group:' + group.id, `Price of: ${group.title}`]));
        if (!list.some((entry) => entry[0] === value)) list.push([value, value]);
        return { label: 'Amount', value, list, write: (next) => next };
      }
      return null;
    }

    function inspectorSections(ctx) {
      const ui = ctx.ui;
      const doc = getDoc();
      const section = (title, key) => ui.sectionBox(title, { persistKey: 'fmpe:' + key });
      if (ctx.kind === 'document' || ctx.kind === 'page') {
        // Nothing selected: the slide itself.
        const page = currentPage(doc);
        if (!page) return;
        ctx.target.innerHTML = '';
        const head = ui.sectionBox(null);
        head.body.appendChild(ui.el('div', { class: 'fmde-inspector-head' }, ui.el('span', { class: 'fmde-inspector-type', html: icon('fa-desktop') }), ui.el('span', { text: `Slide ${pageIndex(doc) + 1} of ${pagesOf(doc).length}` })));
        head.body.appendChild(ui.fieldRow('Name', ui.textInputField(page.name || '', (value) => { ctx.apply({ type: 'page.set', page_id: page.id, prop: 'name', value: text(value) }, 'slide-name'); }, { placeholder: `Slide ${pageIndex(doc) + 1}` })));
        ctx.target.appendChild(head.root);
        const slide = section('Slide', 'slide');
        const background = slideBackground(doc, page);
        const fill = obj(obj(obj(background).style).fill);
        slide.body.appendChild(ui.fieldRow('Background', ui.colorField(typeof fill.color === 'string' ? fill.color : '', (value) => {
          if (!text(value)) return;
          const now = slideBackground(getDoc(), currentPage(getDoc()));
          ctx.apply(now ? { type: 'node.set', node_id: now.id, prop: 'style.fill', value: { type: 'solid', color: value } }
            : { type: 'node.insert', node: backgroundNode(doc, value), page_id: page.id, index: 0 }, 'slide-background');
        })));
        const steps = Present.pageSteps(page).length;
        const transition = Present.TRANSITIONS.find((item) => item.id === Present.pageTransition(page).type) || {};
        const motion = ui.el('button', { type: 'button', class: 'fmpe-link', text: `${transition.label || 'None'} transition \u00b7 ${steps} step${steps === 1 ? '' : 's'}` });
        motion.addEventListener('click', () => visual.openSidePanel('animate'));
        slide.body.appendChild(ui.fieldRow('Motion', motion));
        ctx.target.appendChild(slide.root);

        const deck = section('Presentation', 'deck');
        const size = text(obj(obj(doc.settings).paper).size) === 'slide_4_3' ? 'slide_4_3' : 'slide';
        const seg = ui.el('div', { class: 'fmpe-sizeseg' });
        [['slide', '16:9', 32], ['slide_4_3', '4:3', 24]].forEach(([id, label, width]) => {
          const button = ui.el('button', { type: 'button', class: id === size ? 'on' : '', 'data-fmpe-size': id, html: `<i style="width:${width}px"></i><span>${label}</span>` });
          button.addEventListener('click', () => {
            if (id === size) return;
            const from = M.paperDimensions(doc);
            const to = M.PAPER_SIZES[id];
            const commands = [{ type: 'doc.set', prop: 'settings.paper.size', value: id }];
            // Full-bleed backgrounds follow the slide.
            pagesOf(doc).forEach((entry) => { const node = slideBackground(doc, entry); if (node && Math.abs(Number(node.frame.h) - from.h_pt) < 1) commands.push({ type: 'node.set', node_id: node.id, prop: 'frame', value: Object.assign({}, node.frame, { w: to.w_pt, h: to.h_pt }) }); });
            ctx.apply(commands, 'slide-size');
            visual.zoom('fit-width');
            ctx.refresh();
          });
          seg.appendChild(button);
        });
        deck.body.appendChild(ui.fieldRow('Slide size', seg));
        ctx.target.appendChild(deck.root);
        return;
      }
      if (ctx.kind !== 'node' || !ctx.node) return;
      const node = ctx.node;
      const anchor = ctx.target.querySelector('.fmde-inspector-head')?.closest('.fmde-section') || null;
      const place = (el) => ctx.target.insertBefore(el, anchor ? anchor.nextSibling : ctx.target.firstChild);

      // When clicked: any element can be a button while presenting.
      const action = obj(obj(node.props).action);
      const click = section('When clicked', 'click');
      const setAction = (value) => { ctx.apply({ type: 'node.set', node_id: node.id, prop: 'props.action', value }, 'click-action'); ctx.refresh(); };
      const select = ui.selectField(text(action.type), ACTIONS, (value) => setAction(value ? Object.assign({ type: value }, value === 'goto' ? { page: text(action.page) || text(obj(pagesOf(doc)[0]).id) } : {}, value === 'custom' ? { name: text(action.name) } : {}) : null));
      select.setAttribute('data-fmpe-action', '');
      click.body.appendChild(ui.fieldRow('Action', select));
      if (action.type === 'goto') {
        const target = ui.selectField(text(action.page), pagesOf(doc).map((page, index) => [page.id, `${index + 1} \u00b7 ${text(page.name) || 'Slide ' + (index + 1)}`]), (value) => setAction({ type: 'goto', page: value }));
        target.setAttribute('data-fmpe-action-page', '');
        click.body.appendChild(ui.fieldRow('Slide', target));
      }
      if (action.type === 'custom') {
        const name = ui.textInputField(text(action.name), (value) => setAction({ type: 'custom', name: text(value) }), { placeholder: 'sign, send\u2026' });
        name.setAttribute('data-fmpe-action-name', '');
        click.body.appendChild(ui.fieldRow('Name', name));
        click.body.appendChild(ui.el('div', { class: 'fmpe-hint', text: 'Handed to whatever is showing the presentation, such as signing or sending the estimate.' }));
      }
      place(click.root);

      // A piece of a widget, or the widget itself.
      const assemblyId = assemblyOf(doc, node);
      const entry = obj(obj(doc.assemblies)[assemblyId]);
      if (!assemblyId || !entry.type) return;
      const type = Parts() && Parts().get ? obj(Parts().get(entry.type)) : {};
      const info = ctx.part;
      const box = ui.el('div', { class: 'fmpe-widgetbox', 'data-fmpe-widget': assemblyId });
      box.appendChild(ui.el('div', { class: 'fmpe-widgetbox-head', html: `${icon(type.icon || 'fa-puzzle-piece')}<span>${esc(text(entry.name) || type.title || 'Widget')}</span>${info ? `<span class="fmpe-badge${info.required ? '' : ' soft'}" data-fmpe-required="${info.required ? 'yes' : 'no'}">${info.required ? icon('fa-lock') + 'Required' : 'Optional'}</span>` : ''}` }));
      if (info) box.appendChild(ui.el('p', { html: `<strong>${esc(info.label)}</strong> \u2014 ${info.required ? 'the widget needs this piece. Move, resize and restyle it freely; deleting it deletes the widget.' : 'an optional piece. It can be deleted on its own.'}` }));
      else if (type.description) box.appendChild(ui.el('p', { text: type.description }));
      const missing = M.assemblyMissingParts(entry, M.assemblyParts(doc, assemblyId, []));
      if (missing.length) box.appendChild(ui.el('p', { html: `<span class="fmpe-badge warn">${icon('fa-triangle-exclamation')}Missing pieces</span> ${esc(missing.map((item) => text(obj(type.roles)[item.role]) || item.role).join(', '))}` }));
      const source = sourceOptions(entry.type, obj(entry.config));
      const setConfig = (key, value) => { ctx.apply({ type: 'doc.set', prop: `assemblies.${assemblyId}.config.${key}`, value }, 'widget-source'); ctx.refresh(); };
      if (source) {
        const pick = ui.selectField(source.value, source.list, (value) => setConfig('source', source.write(value)));
        pick.setAttribute('data-fmpe-source', '');
        box.appendChild(ui.fieldRow(source.label, pick));
        if (source.groupId !== undefined && source.groupId !== null) {
          const idField = ui.textInputField(source.groupId, (value) => setConfig('source', { kind: 'group', id: text(value) }), { placeholder: 'shingle_profile' });
          idField.setAttribute('data-fmpe-source-id', '');
          box.appendChild(ui.fieldRow('Group id', idField));
        }
      }
      if (entry.type === 'choice_selection') box.appendChild(ui.fieldRow('Prices', ui.selectField(text(obj(entry.config).price) || 'option', [['option', 'Each option\u2019s price'], ['difference', 'Difference from the choice']], (value) => setConfig('price', value))));
      if (info) {
        const whole = ui.el('button', { type: 'button', class: 'fmpe-link', text: 'Select the whole widget' });
        whole.addEventListener('click', () => visual.select(wholeWidget(getDoc(), assemblyId)));
        box.appendChild(whole);
      }
      const wrap = ui.sectionBox(null, { className: 'fmpe-widget-section' });
      wrap.body.appendChild(box);
      place(wrap.root);
    }

    // ------------------------------------------------------ rail: Interactive
    function centered(doc, w, h) {
      const paper = M.paperDimensions(doc);
      const fit = Math.min(1, (paper.w_pt - 96) / w, (paper.h_pt - 96) / h);
      const size = { w: Math.round(w * fit), h: Math.round(h * fit) };
      return Object.assign(size, { x: Math.round((paper.w_pt - size.w) / 2), y: Math.round((paper.h_pt - size.h) / 2) });
    }
    const topZ = (page) => arr(obj(page).children).reduce((z, node) => Math.max(z, Number(obj(node.frame).z) || 0), 0);
    const defaultConfig = (type) => (type === 'choice_selection' && text(obj(arr(obj(sample).groups)[0]).id) ? { source: { kind: 'group', id: text(sample.groups[0].id) } } : {});

    function insertAssembly(type, presetId) {
      const doc = getDoc();
      const page = currentPage(doc);
      const def = Parts() ? Parts().get(type) : null;
      const preset = def ? arr(def.presets).find((entry) => entry.id === presetId) || arr(def.presets)[0] : null;
      if (!page || !preset) return null;
      const built = Parts().build(type, preset.id, Object.assign(centered(doc, preset.size.w, preset.size.h), { config: defaultConfig(type) }));
      built.node.frame = Object.assign({}, built.node.frame, { z: topZ(page) + 1 });
      const result = apply([
        { type: 'doc.set', prop: 'assemblies', value: Object.assign({}, obj(doc.assemblies), { [built.id]: built.entry }) },
        { type: 'node.insert', node: built.node, page_id: page.id }
      ], 'insert-widget');
      if (result && result.ok === false) { toast('Could not add that here.', false); return null; }
      visual.select([built.node.id]);
      return built.id;
    }
    function insertButton(kind) {
      const doc = getDoc();
      const page = currentPage(doc);
      if (!page) return null;
      const paper = M.paperDimensions(doc);
      const next = kind === 'next';
      const node = buttonNode(next ? 'Next' : 'Back', { type: next ? 'next' : 'back' }, next, { x: next ? paper.w_pt - 72 - 110 : 72, y: paper.h_pt - 62, w: next ? 110 : 92, z: topZ(page) + 1 });
      const result = apply([{ type: 'node.insert', node, page_id: page.id }]);
      if (result && result.ok === false) return null;
      visual.select([node.id]);
      return node.id;
    }

    function renderInteractive(host) {
      railThumbs.forEach((handle) => { try { handle.destroy(); } catch (e) { /* gone */ } });
      railThumbs = [];
      const types = Parts() ? Parts().list() : [];
      host.innerHTML = `<div class="fmpe-rail">
        <div class="fmpe-rail-head"><strong>Interactive</strong><span>Pieces that work while presenting: buttons, and widgets that read the estimate.</span></div>
        <div class="fmpe-group"><div class="fmpe-group-head">${icon('fa-arrow-pointer')}<div><strong>Buttons</strong><span>Any element can be a button. These come ready.</span></div></div>
          <div class="fmpe-presets">
            <button type="button" class="fmpe-preset" data-fmpe-button="back"><span class="shot"><span class="fmpe-btnsample plain">Back</span></span><em>Back button</em></button>
            <button type="button" class="fmpe-preset" data-fmpe-button="next"><span class="shot"><span class="fmpe-btnsample primary">Next</span></span><em>Next button</em></button>
          </div></div>
        ${types.map((type) => `<div class="fmpe-group" data-fmpe-type="${esc(type.id)}"><div class="fmpe-group-head">${icon(type.icon || 'fa-puzzle-piece')}<div><strong>${esc(type.title || type.id)}</strong><span>${esc(type.description || '')}</span></div></div>
          <div class="fmpe-presets">${arr(type.presets).map((preset) => `<button type="button" class="fmpe-preset${obj(preset.size).w > obj(preset.size).h * 1.9 ? ' wide' : obj(preset.size).h > obj(preset.size).w ? ' tall' : ''}" data-fmpe-preset="${esc(type.id)}:${esc(preset.id)}" title="Add to this slide"><span class="shot" data-fmpe-shot></span><em>${esc(preset.label || preset.id)}</em></button>`).join('')}</div></div>`).join('')}
      </div>`;
      host.querySelectorAll('[data-fmpe-button]').forEach((button) => button.addEventListener('click', () => insertButton(button.dataset.fmpeButton)));
      host.querySelectorAll('[data-fmpe-preset]').forEach((button) => {
        const [type, preset] = button.dataset.fmpePreset.split(':');
        button.addEventListener('click', () => insertAssembly(type, preset));
        requestAnimationFrame(() => presetThumb(button.querySelector('[data-fmpe-shot]'), type, preset));
      });
    }
    /** A static picture of a preset, built and rendered exactly as it would be inserted. */
    function presetThumb(stage, type, presetId) {
      if (!stage || !stage.isConnected || !global.FMDocRenderer) return;
      const def = Parts().get(type);
      const preset = arr(def.presets).find((entry) => entry.id === presetId);
      if (!preset) return;
      const pad = 10;
      const doc = M.createDocument({ kind: 'document' });
      doc.settings.paper = { size: { w_pt: preset.size.w + pad * 2, h_pt: preset.size.h + pad * 2 } };
      const built = Parts().build(type, presetId, { x: pad, y: pad, config: defaultConfig(type) });
      doc.assemblies = { [built.id]: built.entry };
      doc.pages = [M.createPage('custom', { children: [built.node] })];
      const natural = { w: (preset.size.w + pad * 2) * 96 / 72, h: (preset.size.h + pad * 2) * 96 / 72 };
      const scale = Math.min(1, (stage.clientWidth - 12) / natural.w, (stage.clientHeight - 12) / natural.h);
      const holder = document.createElement('div');
      holder.style.cssText = `width:${natural.w * scale}px;height:${natural.h * scale}px`;
      stage.appendChild(holder);
      try {
        const handle = global.FMDocRenderer.render(holder, { document: doc, theme: opts.theme, themeContext: opts.themeContext, mode: 'static', widgetData: {}, widgetContext: { preview: true }, scale });
        railThumbs.push(handle);
        Promise.resolve(handle.ready ? handle.ready() : null).then(() => { if (sample && holder.isConnected) Parts().attach(holder, { document: doc, state: sample, readonly: true }); }).catch(() => {});
      } catch (e) { /* the label still says what it is */ }
    }

    // ---------------------------------------------------------- rail: Layers
    function renderLayers(host) {
      const doc = getDoc();
      const page = currentPage(doc);
      const selection = new Set(visual ? visual.selection() : []);
      const animated = new Set();
      Present.pageSteps(page).forEach((step) => step.actions.forEach((action) => animated.add(action.node)));
      const rows = [];
      (function level(nodes, depth) {
        arr(nodes).slice().sort((a, b) => (Number(obj(b.frame).z) || 0) - (Number(obj(a.frame).z) || 0) || nodes.indexOf(b) - nodes.indexOf(a)).forEach((node) => {
          const info = partLabel(doc, node);
          rows.push(`<button type="button" class="fmpe-layer${selection.has(node.id) ? ' sel' : ''}${node.visible === false ? ' off' : ''}" style="padding-left:${8 + depth * 14}px" data-fmpe-layer="${esc(node.id)}">
            ${icon(NODE_ICONS[node.type] || 'fa-square')}<span>${esc(nodeName(node))}</span>
            ${animated.has(node.id) ? `<span class="mark" title="Animated">${icon('fa-bolt')}</span>` : ''}
            ${text(obj(obj(node.props).action).type) ? `<span class="mark" title="Does something when clicked">${icon('fa-arrow-pointer')}</span>` : ''}
            ${info ? `<span class="fmpe-badge${info.required ? '' : ' soft'}" data-fmpe-layer-part="${info.required ? 'required' : 'optional'}" title="${esc(info.label + (info.required ? ' \u00b7 required by ' : ' \u00b7 optional piece of ') + (text(info.entry.name) || 'the widget'))}">${info.required ? icon('fa-lock') : ''}${esc(info.label)}</span>` : ''}
          </button>`);
          if (node.type === 'frame') level(arr(node.children), depth + 1);
        });
      })(arr(obj(page).children), 0);
      host.innerHTML = `<div class="fmpe-rail"><div class="fmpe-rail-head"><strong>Layers</strong><span>${esc(text(obj(page).name) || 'This slide')}, front to back. ${icon('fa-lock')} marks pieces a widget cannot lose.</span></div>
        <div class="fmpe-layers">${rows.join('') || '<div class="fmpe-empty">Nothing on this slide yet.</div>'}</div></div>`;
      host.querySelector('.fmpe-layer.sel')?.scrollIntoView({ block: 'nearest' });
      if (host.dataset.fmpeWired) return;
      host.dataset.fmpeWired = '1';
      host.addEventListener('click', (event) => { const row = event.target.closest('[data-fmpe-layer]'); if (row) visual.select([row.dataset.fmpeLayer]); });
      host.addEventListener('pointerover', (event) => { const row = event.target.closest('[data-fmpe-layer]'); if (row) spotlight(nodeEl(row.dataset.fmpeLayer), '', false); });
      host.addEventListener('pointerout', (event) => { if (event.target.closest('[data-fmpe-layer]')) spot.hidden = true; });
    }

    const railTab = (kind, label, iconName, order, render) => ({
      id: kind, label, icon: iconName, order,
      render(host) { railHost = { kind, host }; render(host); }
    });

    // ----------------------------------------------------------------- mount
    /** Panels follow the document: one refresh per frame, whatever changed. */
    function refresh() {
      if (queued || destroyed) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (destroyed || !visual) return;
        hoverDoc = null;
        renderAnimate();
        if (railHost && railHost.host.isConnected && railHost.kind === 'layers' && visual.getChromeTab() === 'layers') renderLayers(railHost.host);
      });
    }

    const toolbarActions = [];
    if (typeof opts.onClose === 'function') toolbarActions.push({ id: 'close', label: 'Close', title: 'Close the editor', onClick: () => opts.onClose() });
    if (typeof opts.onSave === 'function') toolbarActions.push({ id: 'save', label: text(opts.saveLabel) || 'Save', icon: 'fa-cloud-arrow-up', title: 'Publish this version', onClick: (button) => {
      if (button.disabled) return;
      button.disabled = true;
      Promise.resolve().then(() => { const doc = getDoc(); return Promise.resolve(opts.onSave(doc)).then(() => { savedJson = JSON.stringify(doc); }); }).then(null, (error) => { toast(text(obj(error).message) || 'Could not save.', false); }).then(() => { button.disabled = false; });
    } });
    toolbarActions.push({ id: 'present', label: 'Present', icon: 'fa-play', primary: true, title: 'Present from this slide', onClick: present });

    visual = global.FMVisualEditor.mount(root, {
      document: opts.document ? pinBackgrounds(clone(opts.document)) : blankDocument(),
      profile: 'designer', mode: 'visual', allowedModes: ['visual'],
      theme: opts.theme, themeContext: opts.themeContext, media: opts.media, catalog: opts.catalog,
      resolveScope: opts.scope || undefined, dataPreview: !!opts.scope,
      singlePage: true, keepSidePanelOnSelect: true, inspectTabLabel: 'Design',
      sidePanels: [{ id: 'animate', label: 'Animate', render(host) { animHost = host; wireAnimate(host); renderAnimate(); } }],
      initialSidePanel: opts.initialSidePanel || 'inspect',
      inspectorSections, toolbarActions,
      onChange(doc, meta) { if (typeof opts.onChange === 'function') opts.onChange(doc, meta); },
      chrome: Object.assign({}, obj(opts.chrome), {
        contentKind: 'document',
        tabs: ['elements', 'interactive', 'widgets', 'media', 'text', 'brand', 'layers'],
        customTabs: [railTab('interactive', 'Interactive', 'fa-hand-pointer', 25, renderInteractive), railTab('layers', 'Layers', 'fa-layer-group', 75, renderLayers)],
        collection: { singular: 'Slide', plural: 'Slides' },
        pages, markup: null, qr: null
      })
    });

    savedJson = JSON.stringify(visual.getDocument());
    const column = visual.root.querySelector('.fmwe-ch-canvas-column');
    if (column) {
      banner = document.createElement('div');
      banner.className = 'fmpe-banner';
      banner.hidden = true;
      banner.addEventListener('click', (event) => { if (event.target.closest('[data-fmpe-preview-off]')) setStepPreview(null); });
      column.appendChild(banner);
    }
    const canvas = visual.root.querySelector('.fmde-canvas');
    canvas?.addEventListener('pointermove', onCanvasMove);
    canvas?.addEventListener('pointerleave', () => { spot.hidden = true; });
    canvas?.addEventListener('pointerdown', () => { spot.hidden = true; stopPlaying(); }, true);
    canvas?.addEventListener('scroll', () => { spot.hidden = true; }, { passive: true });
    visual.on('render', () => { spot.hidden = true; decorateCanvas(); refresh(); });
    visual.on('selection', () => { spot.hidden = true; refresh(); });
    visual.on('page', () => { stepPreview = null; stopPlaying(); visual.refreshPages(); refresh(); });
    // PageUp / PageDown walk the deck when nothing is being typed.
    const onKey = (event) => {
      if (player || event.defaultPrevented || !['PageDown', 'PageUp'].includes(event.key) || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      const list = pagesOf(getDoc());
      const next = list[pageIndex({ pages: list }) + (event.key === 'PageDown' ? 1 : -1)];
      if (next) { event.preventDefault(); visual.showPage(next.id); }
    };
    root.addEventListener('keydown', onKey);
    requestAnimationFrame(() => { if (!destroyed) { visual.refreshPages(); decorateCanvas(); } });

    return {
      root,
      editor: visual,
      getDocument: getDoc,
      setDocument(next, setOptions) { stepPreview = null; visual.setDocument(next, setOptions); savedJson = JSON.stringify(visual.getDocument()); refresh(); },
      apply: (command) => visual.apply(command),
      undo: () => visual.undo(),
      redo: () => visual.redo(),
      select: (ids) => visual.select(ids),
      selection: () => visual.selection(),
      currentSlide: currentId,
      showSlide: (id) => visual.showPage(id),
      /** Preview the current slide after `count` steps (null shows everything). */
      previewStep(count) { stepPreview = count === null || count === undefined ? null : Number(count); decorateCanvas(); syncChips(); renderAnimate(); return stepPreview; },
      openAnimate: () => visual.openSidePanel('animate'),
      insertWidget: insertAssembly,
      insertButton,
      present,
      /** The running player while presenting, else null. */
      player: () => (player ? player.instance : null),
      closePresent() { if (player) player.close(); },
      /** True while the document differs from what was last saved (undoing back to it is clean again). */
      isDirty: () => JSON.stringify(visual.getDocument()) !== savedJson,
      markSaved() { savedJson = JSON.stringify(visual.getDocument()); },
      destroy() {
        if (destroyed) return;
        if (player) player.close();
        destroyed = true;
        stopPlaying();
        closeMenu();
        cancelAnimationFrame(hoverFrame);
        root.removeEventListener('keydown', onKey);
        railThumbs.forEach((handle) => { try { handle.destroy(); } catch (e) { /* gone */ } });
        if (canvasParts) { try { canvasParts.destroy(); } catch (e) { /* gone */ } }
        try { visual.destroy(); } catch (e) { /* already gone */ }
        root.remove();
      }
    };
  }

  global.FMPresentationEditor = { version: 1, mount, blankDocument, sampleState, priceSample };
})(typeof window !== 'undefined' ? window : globalThis);
