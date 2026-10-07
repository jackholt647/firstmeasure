/**
 * The roofing sales presentation, as data.
 *
 * FMRoofingPresentation.build() returns an ordinary paged DocModel: slides are
 * pages, the roof diagram is shapes, motion is page.steps / page.transition,
 * and the selections, prices and review are FMDocParts assemblies. Nothing in
 * the player or the editor knows this deck exists — it is a template, and
 * everything in it can be moved, restyled or replaced in the visual editor.
 *
 * Company identity comes from bindings ({{org.logo_url}}, {{org.name}}) and the
 * theme's --fm-primary; choice groups are named by id so the same deck works
 * for whatever the estimate offers.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FMRoofingPresentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const W = 960;
  const H = 540;
  const NAVY = '#0e1a2b';
  const INK = '#101828';
  const BODY = '#475467';
  const MUTED = '#667085';
  const SOFT = '#f4f5f7';
  const LINE = '#e4e7ec';
  const ACCENT = 'var(--fm-primary)';
  const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.';

  // The four layers of the roof diagram, bottom to top.
  const LAYERS = [
    { key: 'decking', name: 'Roof decking', note: 'The plywood your roof is built on.', texture: 'plywood', top: '#d8b584', front: '#b98f58', side: '#a17a47' },
    { key: 'leak_barrier', name: 'Ice & water barrier', note: 'Seals the edges and valleys where water backs up.', texture: 'membrane', top: '#33455c', front: '#25344a', side: '#1c2939', eave: true },
    { key: 'underlayment', name: 'Underlayment', note: 'A second skin under the shingles.', texture: 'felt', top: '#b9c4d0', front: '#93a1b0', side: '#7d8b9a' },
    { key: 'shingles', name: 'Shingles', note: 'The part you see, and the first line of defense.', texture: 'shingle', top: '#565c66', front: '#3d424a', side: '#30343b' }
  ];

  function build(options) {
    const M = (options && options.M) || root.FMDocModel || require('../../doc-model/firstmate-doc-model.js');
    const P = (options && options.P) || root.FMDocParts || require('../../doc-parts/firstmate-doc-parts.js');
    const groups = Object.assign({ shingles: 'shingle_profile', underlayment: 'underlayment_profile', leak_barrier: 'leak_barrier_profile' }, (options && options.groups) || {});

    const doc = M.createDocument({ kind: 'document' });
    doc.settings.paper = { size: 'slide' };
    doc.settings.base_font_pt = 11;
    doc.metadata = Object.assign({}, doc.metadata, { presentation: { version: 1, template: 'roofing' } });
    doc.assemblies = {};
    doc.pages = [];

    // ------------------------------------------------------------ builders
    const frame = (x, y, w, h, z) => ({ x, y, w, h, layout: 'absolute', z: z || 0 });
    const rect = (id, name, x, y, w, h, fill, extra) => M.createNode('shape', Object.assign({ id, name, frame: frame(x, y, w, h), style: Object.assign({ fill: typeof fill === 'string' ? { type: 'solid', color: fill } : fill }, (extra && extra.style) || {}), props: Object.assign({ shape: 'rect', corner_radius: (extra && extra.radius) || 0 }, (extra && extra.props) || {}) }));
    // `material` asks for a drawn texture (FMDocParts.applyTextures) over the flat color.
    const poly = (name, x, y, w, h, points, fill, material) => M.createNode('shape', { name, frame: frame(x, y, w, h), style: { fill: { type: 'solid', color: fill } }, props: Object.assign({ shape: 'polygon', points: points.map(([px, py]) => ({ x: px, y: py })) }, material ? { texture: { kind: material, color: fill } } : {}) });
    const line = (id, name, x, y, w, h, points, color, width) => M.createNode('shape', { id, name, frame: frame(x, y, Math.max(w, 1), Math.max(h, 1)), style: { stroke: { color, width_pt: width || 1.5 } }, props: { shape: 'line', points: points.map(([px, py]) => ({ x: px, y: py })) } });
    function text(id, name, x, y, w, h, value, o) {
      const opt = o || {};
      const runs = Array.isArray(value) ? value : [{ text: value }];
      const node = M.createNode('text', {
        id, name, frame: frame(x, y, w, h),
        props: {
          valign: opt.valign || 'top', line_height: opt.line_height || 1.3, letter_spacing: opt.spacing || 0,
          blocks: [{ id: M.generateId('blk'), type: 'paragraph', align: opt.align || 'left', runs: runs.map((run) => Object.assign({ text: run.text || '' }, run.bind ? { bind: run.bind } : {}, { size_pt: run.size || opt.size || 11, color: run.color || opt.color || INK, weight: run.weight || opt.weight || 400 })) }]
        }
      });
      if (opt.action) node.props.action = opt.action;
      return node;
    }
    function group(id, name, x, y, w, h, children, extra) {
      const e = extra || {};
      return M.createNode('frame', {
        id, name, frame: frame(x, y, w, h),
        style: Object.assign({}, e.fill ? { fill: { type: 'solid', color: e.fill } } : {}, e.radius ? { corner_radius: e.radius } : {}, e.stroke ? { stroke: { color: e.stroke, width_pt: 1 } } : {}, e.shadow ? { shadow: e.shadow } : {}, e.opacity !== undefined ? { opacity: e.opacity } : {}),
        props: Object.assign({ background: null, clip: false, overflow: 'visible', fmde_group: true }, e.action ? { action: e.action } : {}, e.morph ? { morph_key: e.morph } : {}),
        children
      });
    }
    /** A filled box drawn by CSS (gradients, rounded photos); shapes are for geometry. */
    const panel = (id, name, x, y, w, h, fill, radius, opacity) => M.createNode('frame', { id, name, frame: frame(x, y, w, h), style: Object.assign({ fill }, radius ? { corner_radius: radius } : {}, opacity !== undefined ? { opacity } : {}), props: { background: null, clip: false, overflow: 'visible' }, children: [] });
    const button = (id, label, x, y, w, action, primary) => group(id, label, x, y, w, 40, [
      text(id + '_label', 'Label', 0, 12, w, 18, label, { size: 11.5, weight: 700, color: primary ? '#ffffff' : INK, align: 'center' })
    ], { fill: primary ? ACCENT : '#ffffff', radius: 20, stroke: primary ? null : LINE, action, shadow: primary ? { x: 0, y: 6, blur: 16, color: 'rgba(16,24,40,.18)' } : null });
    function logo(id, x, y, w, h) {
      const node = M.createNode('image', { id, name: 'Company logo', frame: frame(x, y, w, h, 5), props: { fit: 'contain', alt: 'Company logo' } });
      node.bind = { props: { 'props.media': '{{org.logo_url}}' }, if: 'not_empty(org.logo_url)' };
      return node;
    }
    function slide(id, name, background, children, extra) {
      const page = M.createPage('custom', Object.assign({ id, name, children: [Object.assign(rect(id + '_bg', 'Background', 0, 0, W, H, background), { locks: { move: true, rotate: true } })].concat(children) }, extra || {}));
      doc.pages.push(page);
      return page;
    }
    const kicker = (id, x, y, value, color) => text(id, 'Kicker', x, y, 420, 16, value.toUpperCase(), { size: 8.5, weight: 800, color: color || ACCENT, spacing: 1.4 });
    /** An assembly placed on the page being built. */
    function assembly(type, preset, o) {
      const built = P.build(type, preset, o);
      doc.assemblies[built.id] = built.entry;
      return built.node;
    }

    /**
     * One layer of the exploded roof: a slab drawn as three faces. Every slide
     * names its layers the same way, so "Match & move" carries them from where
     * they were to where they are.
     */
    function layer(prefix, spec, index, x, y, scale, opacity) {
      const w = 330 * scale;
      const h = 124 * scale;
      // An eave strip covers only the front part of the slab's depth.
      const d = spec.eave ? 0.36 : 1;
      const skew = 0.26;
      const backLeft = [skew * d, 0.74 * (1 - d)];
      const backRight = [1 - skew * (1 - d), 0.74 * (1 - d)];
      const faces = [
        poly('Top', 0, 0, w, h, [backLeft, backRight, [1 - skew, 0.74], [0, 0.74]], spec.top, spec.texture),
        poly('Front', 0, 0, w, h, [[0, 0.74], [1 - skew, 0.74], [1 - skew, 1], [0, 1]], spec.front),
        poly('Side', 0, 0, w, h, [[1 - skew, 0.74], backRight, [backRight[0], backRight[1] + 0.26], [1 - skew, 1]], spec.side)
      ];
      return group(prefix + '_' + spec.key, 'Layer: ' + spec.name, x, y, w, h, faces, { opacity, morph: 'layer:' + spec.key });
    }
    /** The four layers stacked with a gap, optionally fading all but one. */
    function diagram(prefix, x, y, scale, focus) {
      const gap = 58 * scale;
      return LAYERS.map((spec, index) => layer(prefix, spec, index, x, y + (LAYERS.length - 1 - index) * gap, scale, focus && focus !== spec.key ? 0.2 : 1));
    }

    // -------------------------------------------------------------- slides
    // 1. Cover
    slide('cover', 'Welcome', NAVY, [
      panel('cover_glow', 'Accent glow', 500, -200, 700, 700, { type: 'radial', stops: [{ color: 'color-mix(in srgb, var(--fm-primary) 60%, transparent)', at: 0 }, { color: 'transparent', at: 0.68 }] }, 350, 0.6),
      logo('cover_logo', 72, 64, 200, 72),
      rect('cover_bar', 'Accent bar', 72, 214, 56, 5, ACCENT, { radius: 3 }),
      text('cover_title', 'Title', 72, 236, 620, 120, 'Your new roof,\nbuilt around you.', { size: 46, weight: 800, color: '#ffffff', line_height: 1.08 }),
      text('cover_for', 'Prepared for', 72, 372, 620, 24, [{ text: 'Prepared for ', color: '#9fb0c7' }, { text: 'your home', bind: '{{customer.name}}', color: '#ffffff', weight: 700 }], { size: 14 }),
      text('cover_org', 'Company', 72, 478, 500, 18, [{ text: 'Your roofing company', bind: '{{org.name}}' }], { size: 10, color: '#7f8ea5', weight: 600 })
    ], { steps: [
      { id: 'cover_in', name: 'Title', auto: true, actions: [{ node: 'cover_bar', effect: 'wipe', direction: 'right', duration_ms: 500 }, { node: 'cover_title', effect: 'rise', duration_ms: 700, delay_ms: 120 }] },
      { id: 'cover_for_in', name: 'Prepared for', auto: true, actions: [{ node: 'cover_for', effect: 'fade_in', duration_ms: 600 }] }
    ] });

    // 2. About us
    const stat = (id, x, value, label) => group(id, 'Fact', x, 318, 180, 110, [
      text(id + '_v', 'Number', 20, 18, 140, 44, value, { size: 30, weight: 800, color: ACCENT }),
      text(id + '_l', 'Label', 20, 66, 140, 32, label, { size: 9.5, color: BODY, line_height: 1.35 })
    ], { fill: '#ffffff', radius: 14, stroke: LINE, shadow: { x: 0, y: 6, blur: 18, color: 'rgba(16,24,40,.06)' } });
    slide('about', 'About us', SOFT, [
      logo('about_logo', 800, 40, 100, 36),
      kicker('about_k', 72, 72, 'A little about us'),
      text('about_title', 'Title', 72, 96, 560, 84, 'Neighbors first.\nRoofers second.', { size: 34, weight: 800, line_height: 1.1 }),
      text('about_body', 'Body', 72, 196, 520, 96, LOREM, { size: 12.5, color: BODY, line_height: 1.55 }),
      stat('about_s1', 72, '25+', 'Lorem ipsum dolor sit amet consectetur'),
      stat('about_s2', 268, '4,200', 'Sed do eiusmod tempor incididunt'),
      stat('about_s3', 464, '4.9★', 'Ut enim ad minim veniam quis'),
      panel('about_photo', 'Photo', 690, 96, 210, 332, { type: 'linear', angle_deg: 160, stops: [{ color: '#c9d2dd', at: 0 }, { color: '#8f9dae', at: 1 }] }, 18)
    ], { transition: { type: 'push', direction: 'left', duration_ms: 600 }, steps: [
      { id: 'about_1', name: 'Years', actions: [{ node: 'about_s1', effect: 'rise' }] },
      { id: 'about_2', name: 'Roofs', auto: true, actions: [{ node: 'about_s2', effect: 'rise' }] },
      { id: 'about_3', name: 'Rating', auto: true, actions: [{ node: 'about_s3', effect: 'rise' }] }
    ] });

    // 3. What makes a good roof
    const pillar = (id, x, number, title) => group(id, title, x, 208, 252, 250, [
      text(id + '_n', 'Number', 24, 22, 60, 40, number, { size: 28, weight: 800, color: ACCENT }),
      text(id + '_t', 'Title', 24, 72, 204, 52, title, { size: 17, weight: 800, line_height: 1.15 }),
      text(id + '_b', 'Body', 24, 132, 204, 100, LOREM.slice(0, 118) + '.', { size: 10.5, color: BODY, line_height: 1.5 })
    ], { fill: '#ffffff', radius: 16, stroke: LINE, shadow: { x: 0, y: 8, blur: 22, color: 'rgba(16,24,40,.06)' } });
    slide('good_roof', 'What makes a good roof', SOFT, [
      kicker('good_k', 72, 72, 'What makes a good roof'),
      text('good_title', 'Title', 72, 96, 700, 84, 'A roof is a system,\nnot a single product.', { size: 34, weight: 800, line_height: 1.1 }),
      pillar('good_1', 72, '01', 'It keeps water out'),
      pillar('good_2', 354, '02', 'It lets the house breathe'),
      pillar('good_3', 636, '03', 'It is installed to last')
    ], { transition: { type: 'push', direction: 'left', duration_ms: 600 }, steps: [
      { id: 'good_s1', name: 'Water', actions: [{ node: 'good_1', effect: 'rise' }] },
      { id: 'good_s2', name: 'Ventilation', actions: [{ node: 'good_2', effect: 'rise' }] },
      { id: 'good_s3', name: 'Installation', actions: [{ node: 'good_3', effect: 'rise' }] }
    ] });

    // 4. Anatomy of a roof: the layers build from the deck up, each with its label.
    const anatomy = diagram('an', 150, 150, 1.0, null);
    const labels = [];
    const anatomySteps = [];
    LAYERS.forEach((spec, index) => {
      const y = 150 + (LAYERS.length - 1 - index) * 58 + 46;
      const id = 'an_label_' + spec.key;
      labels.push(group(id, 'Label: ' + spec.name, 520, y - 16, 380, 50, [
        line(id + '_line', 'Leader', 0, 16, 70, 1, [[0, 0.5], [1, 0.5]], '#98a2b3', 1.25),
        rect(id + '_dot', 'Dot', -4, 12, 8, 8, ACCENT, { radius: 4 }),
        text(id + '_name', 'Name', 84, 4, 290, 20, spec.name, { size: 14, weight: 800 }),
        text(id + '_note', 'Note', 84, 26, 290, 20, spec.note, { size: 10, color: BODY })
      ]));
      anatomySteps.push({ id: 'an_step_' + spec.key, name: spec.name, auto: index === 0, actions: [{ node: 'an_' + spec.key, effect: 'rise', duration_ms: 650 }, { node: id, effect: 'fade_in', duration_ms: 500, delay_ms: 250 }] });
    });
    slide('anatomy', 'Anatomy of a roof', '#ffffff', [
      kicker('an_k', 72, 56, 'Anatomy of a roof'),
      text('an_title', 'Title', 72, 80, 700, 44, 'Four layers, each with a job.', { size: 30, weight: 800 })
    ].concat(anatomy, labels), { transition: { type: 'fade', duration_ms: 500 }, steps: anatomySteps });

    // 5-7. One slide per layer the customer chooses: the diagram moves left,
    // the layer in question stays lit, and a line leads to its options.
    function choiceSlide(id, key, title, body, groupId) {
      const index = LAYERS.findIndex((spec) => spec.key === key);
      const layerY = 176 + (LAYERS.length - 1 - index) * 49 + 40;
      slide(id, LAYERS[index].name, '#ffffff', [
        kicker(id + '_k', 72, 56, 'Layer ' + (index + 1) + ' of ' + LAYERS.length),
        text(id + '_title', 'Title', 72, 80, 500, 44, title, { size: 30, weight: 800 }),
        text(id + '_body', 'Body', 72, 128, 440, 40, body, { size: 11.5, color: BODY, line_height: 1.5 })
      ].concat(diagram('d_' + id, 96, 176, 0.85, key), [
        line(id + '_lead', 'Leader', 356, layerY, 248, 1, [[0, 0.5], [1, 0.5]], ACCENT, 1.75),
        rect(id + '_lead_dot', 'Leader dot', 351, layerY - 4, 10, 10, ACCENT, { radius: 5 }),
        rect(id + '_panel', 'Options panel', 604, 0, 356, H, SOFT),
        button(id + '_back', 'Back', 72, 478, 92, { type: 'back' }, false),
        button(id + '_next', 'Next', 174, 478, 110, { type: 'next' }, true),
        assembly('choice_selection', 'stack', { id: 'asm_' + key, name: LAYERS[index].name + ' options', x: 632, y: 56, w: 300, h: 428, config: { source: { kind: 'group', id: groupId } } }),
        assembly('detail_panel', 'wide', { id: 'asm_' + key + '_detail', name: LAYERS[index].name + ' details', x: 72, y: 184, w: 500, h: 276, config: { source: { kind: 'group', id: groupId } } })
      ]), { transition: { type: 'morph', duration_ms: 800 }, steps: [
        { id: id + '_s1', name: 'Options', auto: true, actions: [{ node: id + '_lead_dot', effect: 'zoom_in', duration_ms: 300 }, { node: id + '_lead', effect: 'draw', duration_ms: 600 }] }
      ] });
    }
    choiceSlide('choose_shingles', 'shingles', 'Choose your shingle.', 'Every option here is a full architectural shingle. The difference is thickness, definition and how long the color holds.', groups.shingles);
    choiceSlide('choose_underlayment', 'underlayment', 'What goes under them.', 'Underlayment is the backup. If wind lifts a shingle, this is what keeps the deck dry.', groups.underlayment);
    choiceSlide('choose_leak_barrier', 'leak_barrier', 'Where water backs up.', 'Eaves, valleys and penetrations get a self-sealing membrane. It closes around every nail.', groups.leak_barrier);

    // 8. Add-ons
    slide('addons', 'Add-ons', SOFT, [
      kicker('add_k', 72, 56, 'While we are up there'),
      text('add_title', 'Title', 72, 80, 700, 44, 'Worth doing at the same time.', { size: 30, weight: 800 }),
      assembly('choice_selection', 'panels', { id: 'asm_addons', name: 'Add-ons', x: 72, y: 100, w: 816, h: 360, config: { source: { kind: 'addons' }, keep_title: true } }),
      button('addons_back', 'Back', 72, 478, 92, { type: 'back' }, false),
      button('addons_next', 'See my estimate', 174, 478, 170, { type: 'next' }, true)
    ], { transition: { type: 'push', direction: 'left', duration_ms: 600 } });
    // The panels preset comes with a heading; this slide has its own.
    M.walkNodes(doc, (node) => { const part = M.nodePart(node); if (part && part.assembly === 'asm_addons' && part.role === 'title') node.visible = false; });

    // 9. The estimate
    slide('estimate', 'Your estimate', '#ffffff', [
      kicker('est_k', 72, 56, 'Your estimate'),
      text('est_title', 'Title', 72, 80, 480, 44, 'The roof you just built.', { size: 30, weight: 800 }),
      assembly('estimate_compare', 'rows', { id: 'asm_compare', name: 'Your selections', x: 72, y: 146, w: 500, h: 268, count: 4, options: 3 }),
      text('est_note', 'Note', 72, 430, 500, 34, 'Includes tear-off, disposal, permits and cleanup. Tap another option on any row and the price follows.', { size: 9.5, color: MUTED, line_height: 1.5 }),
      group('est_card', 'Total card', 600, 56, 288, 428, [
        logo('est_logo', 28, 28, 120, 40),
        assembly('price_display', 'large', { id: 'asm_total', name: 'Total', x: 28, y: 110, w: 232, h: 92, config: { source: 'total' } }),
        rect('est_rule', 'Rule', 28, 222, 232, 1, 'rgba(255,255,255,.16)'),
        assembly('price_display', 'inline', { id: 'asm_deposit', name: 'Deposit', x: 28, y: 240, w: 232, h: 26, config: { source: 'deposit' } }),
        assembly('price_display', 'inline', { id: 'asm_balance', name: 'Balance', x: 28, y: 274, w: 232, h: 26, config: { source: 'balance' } }),
        button('est_sign', 'Sign now', 28, 322, 232, { type: 'goto', page: 'sign' }, true),
        button('est_send', 'Send me the estimate', 28, 370, 232, { type: 'custom', name: 'send' }, false)
      ], { fill: NAVY, radius: 22, shadow: { x: 0, y: 18, blur: 44, color: 'rgba(14,26,43,.28)' } }),
      assembly('detail_panel', 'tall', { id: 'asm_estimate_detail', name: 'Option details', x: 600, y: 56, w: 288, h: 428, config: { source: { kind: 'any' } } })
    ], { transition: { type: 'fade', duration_ms: 500 }, steps: [
      { id: 'est_in', name: 'Total', auto: true, actions: [{ node: 'est_card', effect: 'rise', duration_ms: 700 }] }
    ] });
    // The total card is dark: its labels and amounts are light.
    const light = { asm_total: ['#9fb0c7', '#ffffff'], asm_deposit: ['#9fb0c7', '#ffffff'], asm_balance: ['#9fb0c7', '#ffffff'] };
    const labelText = { asm_total: 'Your total', asm_deposit: 'Due at signing', asm_balance: 'Due on completion' };
    M.walkNodes(doc, (node) => {
      const part = M.nodePart(node);
      if (!part || !light[part.assembly] || node.type !== 'text') return;
      const run = node.props.blocks[0].runs[0];
      run.color = light[part.assembly][part.role === 'label' ? 0 : 1];
      if (part.role === 'label') run.text = labelText[part.assembly];
    });

    // 10. Sign
    slide('sign', 'Make it official', NAVY, [
      logo('sign_logo', 72, 56, 160, 56),
      text('sign_title', 'Title', 72, 150, 420, 96, 'Ready when\nyou are.', { size: 40, weight: 800, color: '#ffffff', line_height: 1.08 }),
      text('sign_body', 'Body', 72, 258, 380, 60, 'Sign below to lock in today’s selections and price, or send this to yourself and decide later.', { size: 12, color: '#9fb0c7', line_height: 1.55 }),
      assembly('price_display', 'large', { id: 'asm_sign_total', name: 'Total', x: 72, y: 346, w: 300, h: 92, config: { source: 'total' } }),
      group('sign_card', 'Signature card', 520, 56, 368, 428, [
        text('sign_card_title', 'Heading', 28, 26, 312, 22, 'Accept this estimate', { size: 15, weight: 800 }),
        text('sign_card_body', 'What happens', 28, 58, 312, 60, 'Your selections and today\u2019s price go onto the agreement. You sign it right here on this screen.', { size: 11, color: BODY, line_height: 1.55 }),
        assembly('selection_review', 'rows', { id: 'asm_sign_review', name: 'Your selections', x: 28, y: 126, w: 312, h: 96, count: 3 }),
        button('sign_accept', 'Accept & sign', 28, 236, 312, { type: 'custom', name: 'sign' }, true),
        button('sign_send', 'Send it to me instead', 28, 288, 312, { type: 'custom', name: 'send' }, false),
        text('sign_change', 'Change', 28, 350, 312, 18, 'Change a selection', { size: 10.5, weight: 700, color: MUTED, align: 'center', action: { type: 'goto', page: 'estimate' } })
      ], { fill: '#ffffff', radius: 22, shadow: { x: 0, y: 18, blur: 44, color: 'rgba(0,0,0,.3)' } })
    ], { transition: { type: 'zoom', duration_ms: 600 } });
    // A compact read-only recap on the signing card.
    for (const page of doc.pages) M.walkNodes({ kind: 'document', pages: [page] }, (node) => {
      const part = M.nodePart(node);
      if (part && part.assembly === 'asm_sign_review' && (part.role === 'review.edit' || part.role === 'review.price')) node.visible = false;
      if (part && part.assembly === 'asm_sign_review' && part.role === 'review.row') { node.style = Object.assign({}, node.style, { stroke: null, fill: { type: 'solid', color: '#f7f8fa' } }); }
    });
    M.walkNodes(doc, (node) => {
      const part = M.nodePart(node);
      if (!part || part.assembly !== 'asm_sign_total' || node.type !== 'text') return;
      node.props.blocks[0].runs[0].color = part.role === 'label' ? '#9fb0c7' : '#ffffff';
      if (part.role === 'label') node.props.blocks[0].runs[0].text = 'Your total';
    });

    return doc;
  }

  /** A stand-in live state, for previews and the editor before real prices exist. */
  function sampleState() {
    const option = (id, title, description, color, price_cents, selected) => ({ id, title, description, color: /^#/.test(color) ? color : '', swatch: /^#/.test(color) ? '' : color, details: description + ' Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.', price_cents, selected: !!selected });
    return {
      groups: [
        { id: 'shingle_profile', title: 'Shingles', options: [
          option('gaf_ns', 'GAF Timberline NS', 'Natural Shadow. Clean, classic architectural look.', '#4a4d52', 974400),
          option('gaf_hd', 'GAF Timberline HDZ', 'High definition, with the widest nailing zone.', '#6f6354', 1089200, true),
          option('gaf_uhdz', 'GAF Timberline UHDZ', 'Ultra-thick, with a bolder shadow line.', '#55606a', 1302000)
        ] },
        { id: 'underlayment_profile', title: 'Underlayment', options: [
          option('underlayment', 'Synthetic underlayment', 'Light, strong and tear resistant.', '#c9d1da', 142800, true),
          option('gaf_feltbuster', 'GAF FeltBuster', 'High-traction synthetic felt.', '#aebbc9', 168000),
          option('gaf_tiger_paw', 'GAF Tiger Paw', 'Premium, with moisture control.', '#93a4b6', 226800)
        ] },
        { id: 'leak_barrier_profile', title: 'Ice & water barrier', options: [
          option('ice_water', 'Ice & water shield', 'Self-sealing membrane at eaves and valleys.', '#3a4a60', 86400, true),
          option('gaf_weatherwatch', 'GAF WeatherWatch', 'Mineral-surfaced leak barrier.', '#2f3d52', 104400),
          option('owens_weatherlock', 'Owens Corning WeatherLock', 'Flexible, for complex roof lines.', '#44405c', 118800)
        ] }
      ],
      addons: [
        option('gutters', 'Seamless gutters', 'New 6-inch aluminum gutters and downspouts.', 'linear-gradient(135deg,#e6e9ee,#b4bcc8)', 248000),
        option('ridge_vent', 'Ridge ventilation', 'Continuous ridge vent to keep the attic cool and dry.', 'linear-gradient(135deg,#d9c9a8,#a68f63)', 96000),
        option('skylight', 'Skylight re-flash', 'New flashing kits around both skylights.', 'linear-gradient(135deg,#bfe0f2,#6fa8cc)', 72000)
      ],
      base_cents: 412030,
      totals: {}
    };
  }
  /** Recompute a sample state's totals from its choices (the server does this for real estimates). */
  function priceSample(state) {
    const picked = (state.groups || []).reduce((sum, group) => sum + (Number(((group.options || []).find((entry) => entry.selected) || {}).price_cents) || 0), 0);
    const extras = (state.addons || []).filter((entry) => entry.selected).reduce((sum, entry) => sum + (Number(entry.price_cents) || 0), 0);
    const total = (Number(state.base_cents) || 0) + picked + extras;
    const deposit = Math.round(total * 0.3 / 100) * 100;
    state.totals = { subtotal_cents: total, tax_cents: 0, total_cents: total, deposit_cents: deposit, balance_cents: total - deposit };
    return state;
  }

  return { build, sampleState, priceSample, LAYERS };
});
