/**
 * FMDocParts — functional widgets assembled from ordinary document nodes.
 *
 * An assembly (FMDocModel "Assemblies") is declared in doc.assemblies and made
 * of nodes that carry props.part = { assembly, role, key? }. This library owns
 * the two things the nodes cannot say for themselves:
 *
 *   1. what an assembly type is made of — its required roles and the preset
 *      layouts it can be inserted as (FMDocParts.build), and
 *   2. what the parts do at view time — fill themselves from the live state
 *      and report clicks (FMDocParts.attach).
 *
 * The layout is the author's. A selection's options can be three full-height
 * panels or three lines with a bullet; the behavior only needs each option's
 * parts to exist somewhere in the document. What it reports is what a contract
 * needs: which options were shown and which one was chosen.
 *
 * Live state (host-supplied; the same shape whatever produced the prices):
 *   {
 *     groups:  [{ id, title, options: [{ id, title, description?, image_url?, swatch?, price_cents, selected }] }],
 *     addons:  [{ id, title, description?, image_url?, price_cents, selected }],
 *     totals:  { subtotal_cents, tax_cents, total_cents, deposit_cents, ... },
 *     values:  { any other named amounts or text }
 *   }
 * Inputs reported through onInput:
 *   { type: "choice", group, option, presented: [option ids] }
 *   { type: "addon", addon, selected, presented: [addon ids] }
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FMDocParts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const arr = (value) => (Array.isArray(value) ? value : []);
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const text = (value) => String(value ?? '').trim();
  const model = () => root.FMDocModel || (typeof require === 'function' ? require('../doc-model/firstmate-doc-model.js') : null);

  function money(cents, { sign = false, whole = true } = {}) {
    const value = Number(cents) || 0;
    const amount = Math.abs(value) / 100;
    const body = amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: whole && Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: whole && Number.isInteger(amount) ? 0 : 2 });
    return (value < 0 ? '−' : (sign ? '+' : '')) + body;
  }

  // ------------------------------------------------------------- textures
  // Product photos are often missing; a drawn texture in the product's own
  // color says "shingle" or "membrane" better than a grey box.
  function shade(hex, amount) {
    const match = /^#?([0-9a-f]{6})$/i.exec(text(hex));
    if (!match) return text(hex) || '#888888';
    const value = parseInt(match[1], 16);
    const channel = (shift) => Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) + amount * 255)));
    return '#' + [16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('');
  }
  const TEXTURE_COLORS = {
    shingle: ['#5b5f66', '#6b5b4a', '#47525e', '#7a6a55'],
    felt: ['#c9d1da', '#b7c2ce', '#a5b3c2', '#d6dbe2'],
    membrane: ['#3a4a60', '#2f3d52', '#44405c', '#34465a'],
    plywood: ['#d8b584', '#cfa672', '#e0c092']
  };
  /** The texture a selection of this kind of product is drawn with. */
  function textureKind(groupId) {
    const id = text(groupId).toLowerCase();
    if (/shingle|roof_cover|field/.test(id)) return 'shingle';
    if (/underlay|felt/.test(id)) return 'felt';
    if (/leak|ice|water|membrane|barrier/.test(id)) return 'membrane';
    if (/deck|plywood|sheath/.test(id)) return 'plywood';
    return '';
  }
  /** The drawing itself: { w, h, body } of SVG markup. */
  function textureArt(kind, color, index) {
    const palette = TEXTURE_COLORS[kind];
    if (!palette) return null;
    const base = /^#?[0-9a-f]{6}$/i.test(text(color)) ? (text(color).startsWith('#') ? text(color) : '#' + text(color)) : palette[(Number(index) || 0) % palette.length];
    const W = 240, H = 160;
    // Deterministic variation: the same product always draws the same.
    let seed = 7;
    for (const ch of kind + base) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
    const rand = () => { seed = (seed * 137 + 187) % 9973; return seed / 9973; };
    let body = `<rect width="${W}" height="${H}" fill="${base}"/>`;
    if (kind === 'shingle') {
      for (let row = 0; row < 5; row += 1) {
        const y = row * 32;
        for (let x = -60 + (row % 2) * 30; x < W; x += 60) {
          body += `<rect x="${x + 1}" y="${y}" width="58" height="32" fill="${shade(base, (rand() - 0.5) * 0.14)}"/>`;
          for (let n = 0; n < 5; n += 1) body += `<rect x="${x + 4 + rand() * 50}" y="${y + 3 + rand() * 24}" width="${2 + rand() * 5}" height="1.2" fill="${shade(base, rand() > 0.5 ? 0.12 : -0.1)}" opacity=".55"/>`;
        }
        body += `<rect x="0" y="${y + 29}" width="${W}" height="3" fill="${shade(base, -0.2)}" opacity=".7"/><rect x="0" y="${y}" width="${W}" height="1.5" fill="${shade(base, 0.16)}" opacity=".5"/>`;
      }
    } else if (kind === 'felt') {
      for (let x = -H; x < W; x += 9) body += `<path d="M${x} ${H} L${x + H} 0" stroke="${shade(base, -0.06)}" stroke-width="1"/><path d="M${x} 0 L${x + H} ${H}" stroke="${shade(base, 0.07)}" stroke-width="1"/>`;
      for (let y = 40; y < H; y += 60) body += `<path d="M0 ${y} H${W}" stroke="${shade(base, -0.18)}" stroke-width="1.2" stroke-dasharray="10 7" opacity=".6"/>`;
    } else if (kind === 'membrane') {
      for (let n = 0; n < 420; n += 1) body += `<circle cx="${(rand() * W).toFixed(1)}" cy="${(rand() * H).toFixed(1)}" r="${(0.5 + rand() * 0.9).toFixed(2)}" fill="${shade(base, rand() > 0.5 ? 0.16 : -0.12)}" opacity=".7"/>`;
      body += `<path d="M-20 ${H} L${W * 0.55} -20 L${W * 0.75} -20 L0 ${H + 40}Z" fill="#ffffff" opacity=".07"/>`;
    } else {
      for (let y = 6; y < H; y += 7) {
        const wobble = rand() * 6;
        body += `<path d="M0 ${y} C ${W * 0.25} ${y - wobble}, ${W * 0.5} ${y + wobble}, ${W} ${y - wobble / 2}" fill="none" stroke="${shade(base, -0.08 - rand() * 0.08)}" stroke-width="${(0.6 + rand()).toFixed(2)}" opacity=".7"/>`;
      }
      body += `<ellipse cx="${60 + rand() * 120}" cy="${40 + rand() * 80}" rx="14" ry="6" fill="none" stroke="${shade(base, -0.2)}" stroke-width="1.4" opacity=".6"/>`;
    }
    return { w: W, h: H, body };
  }
  /** An SVG data URI: kind is shingle | felt | membrane | plywood. */
  function texture(kind, color, index) {
    const art = textureArt(kind, color, index);
    return art ? 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.w} ${art.h}" preserveAspectRatio="xMidYMid slice">${art.body}</svg>`) : '';
  }
  const textureBackground = (kind, color, index) => { const uri = texture(kind, color, index); return uri ? `center / cover no-repeat url("${uri}")` : ''; };

  /**
   * Draw the material of every node that asks for one
   * (node.props.texture = { kind, color }). The texture is made here, at view
   * time, so a stored layout never carries an embedded image.
   */
  function applyTextures(rootEl, doc) {
    const M = model();
    if (!rootEl || !M || typeof document === 'undefined') return;
    M.walkNodes(obj(doc), (node) => {
      const want = obj(obj(node.props).texture);
      if (!want.kind) return;
      const art = textureArt(text(want.kind), text(want.color));
      if (!art) return;
      rootEl.querySelectorAll(`[data-node-id="${String(node.id).replace(/[^a-z0-9_-]/gi, '')}"]`).forEach((el) => {
        const shape = el.querySelector('svg polygon, svg path, svg rect, svg ellipse');
        if (!shape) { el.style.background = `center / cover no-repeat url("${texture(text(want.kind), text(want.color))}")`; return; }
        const svg = shape.ownerSVGElement;
        const id = 'fmtex-' + String(node.id).replace(/[^a-z0-9_-]/gi, '');
        svg.querySelector('#' + id)?.remove();
        const NS = 'http://www.w3.org/2000/svg';
        const pattern = document.createElementNS(NS, 'pattern');
        pattern.setAttribute('id', id);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('width', '1');
        pattern.setAttribute('height', '1');
        // A four-cornered face (the top of a slab) gets the drawing laid in
        // its own plane: courses run along its front edge and lean with it.
        const points = shape.tagName.toLowerCase() === 'polygon' && shape.points && shape.points.numberOfItems === 4 ? Array.from({ length: 4 }, (_, i) => shape.points.getItem(i)) : null;
        let box = null;
        try { box = shape.getBBox(); } catch (e) { box = null; }
        if (points) {
          const [a, b, , d] = points;
          pattern.setAttribute('patternTransform', `matrix(${b.x - a.x} ${b.y - a.y} ${d.x - a.x} ${d.y - a.y} ${a.x} ${a.y})`);
        } else if (box && box.width && box.height) {
          pattern.setAttribute('patternTransform', `matrix(${box.width} 0 0 ${box.height} ${box.x} ${box.y})`);
        } else return;
        pattern.innerHTML = `<g transform="scale(${1 / art.w} ${1 / art.h})">${art.body}</g>`;
        svg.insertBefore(pattern, svg.firstChild);
        shape.setAttribute('fill', `url(#${id})`);
        shape.style.fill = `url(#${id})`;
      });
    });
  }

  const types = new Map();
  /** def: { title, icon, required, presets: [{ id, label, size:{w,h}, build(h) }], attach(env) } */
  function register(id, def) { types.set(id, Object.assign({ id }, def)); }
  const get = (id) => types.get(id) || null;
  const list = () => Array.from(types.values());

  // ------------------------------------------------------------- building
  /** Node builders in assembly-local coordinates, shared by every preset. */
  function helpers(assemblyId) {
    const M = model();
    const part = (role, key) => (role ? { part: Object.assign({ assembly: assemblyId, role }, key === undefined ? {} : { key: String(key) }) } : {});
    const frame = (x, y, w, h, extra) => Object.assign({ x, y, w, h, layout: 'absolute' }, extra || {});
    return {
      M,
      part,
      text(name, x, y, w, h, value, options) {
        const o = options || {};
        return M.createNode('text', {
          name, frame: frame(x, y, w, h),
          props: Object.assign({
            valign: o.valign || 'top', line_height: o.line_height || 1.25,
            blocks: [{ id: M.generateId('blk'), type: 'paragraph', align: o.align || 'left', runs: [Object.assign({ text: value }, o.size ? { size_pt: o.size } : {}, o.color ? { color: o.color } : {}, o.weight ? { weight: o.weight } : {})] }]
          }, part(o.role, o.key))
        });
      },
      box(name, x, y, w, h, options) {
        const o = options || {};
        return M.createNode('frame', {
          name, frame: frame(x, y, w, h),
          style: Object.assign({}, o.fill ? { fill: { type: 'solid', color: o.fill } } : {}, o.radius ? { corner_radius: o.radius } : {}, o.stroke ? { stroke: { color: o.stroke, width_pt: o.stroke_width || 1 } } : {}, o.shadow ? { shadow: o.shadow } : {}),
          props: Object.assign({ background: null, clip: !!o.clip, overflow: 'visible' }, o.group ? { fmde_group: true } : {}, part(o.role, o.key)),
          children: o.children || []
        });
      }
    };
  }

  /**
   * Build an assembly from one of its presets.
   * -> { id, entry, node } — add `entry` under doc.assemblies[id] and insert `node`.
   */
  function build(type, presetId, options) {
    const def = get(type);
    if (!def) throw new Error('Unknown assembly type: ' + type);
    const preset = arr(def.presets).find((entry) => entry.id === presetId) || arr(def.presets)[0];
    const o = obj(options);
    const M = model();
    const id = text(o.id) || M.generateId('asm');
    const size = { w: Number(o.w) || preset.size.w, h: Number(o.h) || preset.size.h };
    const h = helpers(id);
    const children = preset.build(h, Object.assign({}, o, size));
    const node = h.box(text(o.name) || def.title, Number(o.x) || 0, Number(o.y) || 0, size.w, size.h, { group: true, children });
    return { id, node, entry: { type, name: text(o.name) || def.title, preset: preset.id, config: Object.assign({}, obj(def.defaults), obj(o.config)), required: def.required } };
  }

  /** Build and add to a document page in one call (templates and agents). */
  function insert(doc, pageId, type, presetId, options) {
    const M = model();
    const built = build(type, presetId, options);
    doc.assemblies = Object.assign({}, obj(doc.assemblies), { [built.id]: built.entry });
    M.insertNode(doc, built.node, { page_id: pageId });
    return built;
  }

  // ------------------------------------------------------------ view time
  const STYLE_ID = 'fmparts-styles';
  const CSS = `
[data-part-role="option"]{cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,outline-color .18s ease;outline:2.5px solid transparent;outline-offset:-1px;border-radius:inherit}
[data-part-role="option"]:hover{transform:translateY(-2px)}
[data-part-role="option"][data-part-selected]{outline-color:var(--fm-primary,#2563eb);box-shadow:0 10px 28px color-mix(in srgb,var(--fm-primary,#2563eb) 26%,transparent)}
[data-part-role="option"]:focus-visible{outline-color:var(--fm-primary,#2563eb);outline-style:dashed}
[data-part-role="option.mark"]{opacity:0;transform:scale(.6);transition:opacity .18s ease,transform .22s cubic-bezier(.3,1.6,.5,1)}
[data-part-selected] [data-part-role="option.mark"],[data-part-role="option.mark"][data-part-selected]{opacity:1;transform:none}
[data-part-empty]{visibility:hidden!important;pointer-events:none!important}
[data-part-role="review.edit"],[data-part-action]{cursor:pointer}
[data-part-role="review.edit"]:hover{filter:brightness(1.08)}
[data-part-busy]{pointer-events:none}
[data-part-focus] [data-part-role="option.more"],[data-part-focus] [data-part-role="row.option.info"]{background:var(--fm-primary,#2563eb)!important;filter:none}
[data-part-focus] [data-part-role="option.more"] *,[data-part-focus] [data-part-role="row.option.info"] *{color:#fff!important}
[data-part-role="option.more"],[data-part-role="row.option.info"],[data-part-role="detail.close"]{cursor:pointer;transition:filter .15s ease,transform .15s ease}
[data-part-role="option.more"]:hover,[data-part-role="row.option.info"]:hover,[data-part-role="detail.close"]:hover{filter:brightness(.94);transform:scale(1.05)}
[data-part-role="row.option"]{cursor:pointer;outline:2px solid transparent;outline-offset:-1px;transition:outline-color .15s ease,background .15s ease,transform .15s ease}
[data-part-role="row.option"]:hover{transform:translateY(-1px)}
[data-part-role="row.option"][data-part-selected]{outline-color:var(--fm-primary,#2563eb);background:color-mix(in srgb,var(--fm-primary,#2563eb) 8%,#fff)!important}
[data-part-role="detail"][data-part-live]{transition:opacity .22s ease,transform .26s cubic-bezier(.3,.8,.3,1);opacity:0;pointer-events:none;transform:translateY(12px) scale(.98)}
[data-part-role="detail"][data-part-live][data-part-open]{opacity:1;pointer-events:auto;transform:none}
@media (prefers-reduced-motion:reduce){[data-part-role="option"],[data-part-role="option.mark"]{transition:none}}
`;
  function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** Write a part's text into its first run, keeping the author's styling. */
  function setText(el, value) {
    if (!el) return;
    const next = text(value);
    const runs = el.querySelectorAll('p span, h1 span, h2 span, h3 span, li span, span');
    const target = runs[0] || el.querySelector('p') || el;
    if (target.textContent !== next) target.textContent = next;
    for (let i = 1; i < runs.length; i += 1) if (runs[i] !== target && runs[i].textContent) runs[i].textContent = '';
  }
  /** Shrink a one-line part's text until it fits its box (an amount must never be cut off). */
  function fitLine(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const run = el.querySelector('p span, span') || el.querySelector('p');
    if (!run) return;
    run.style.whiteSpace = 'nowrap';
    run.style.display = 'inline-block';
    run.style.transform = '';
    const box = el.getBoundingClientRect().width;
    const need = run.getBoundingClientRect().width;
    if (!box || !need || need <= box) return;
    const align = getComputedStyle(run.parentElement || el).textAlign;
    run.style.transformOrigin = align === 'right' || align === 'end' ? '100% 60%' : (align === 'center' ? '50% 60%' : '0 60%');
    run.style.transform = `scale(${Math.max(0.4, box / need)})`;
  }
  /** Count a money part to its new amount instead of snapping. */
  function setMoney(el, cents, options) {
    if (!el) return;
    const to = Number(cents) || 0;
    const from = el.__fmpartsCents;
    el.__fmpartsCents = to;
    cancelAnimationFrame(el.__fmpartsFrame || 0);
    const reduced = !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (from === undefined || from === to || reduced || typeof requestAnimationFrame !== 'function') { setText(el, money(to, options)); fitLine(el); return; }
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 420);
      const eased = 1 - Math.pow(1 - t, 3);
      setText(el, money(Math.round((from + (to - from) * eased) / 100) * 100, options));
      if (t < 1) el.__fmpartsFrame = requestAnimationFrame(tick); else { setText(el, money(to, options)); fitLine(el); }
    };
    el.__fmpartsFrame = requestAnimationFrame(tick);
  }
  function setImage(el, url, swatch) {
    if (!el) return;
    const img = el.querySelector('img');
    if (img && url) { if (img.getAttribute('src') !== url) img.setAttribute('src', url); return; }
    el.style.background = url ? `center / cover no-repeat url("${String(url).replace(/"/g, '%22')}")` : (swatch || '');
  }

  /**
   * Wire every assembly under rootEl.
   * options: { document, state, onInput(input) -> state | Promise<state> | void, navigate(target), readonly }
   */
  function attach(rootEl, options) {
    ensureStyles();
    let opts = Object.assign({}, options || {});
    let state = obj(opts.state);
    let destroyed = false;
    // What is being looked at closer ("See more"): view state, never saved.
    let focus = null;
    const assemblies = () => obj(obj(opts.document).assemblies);
    const parts = (assemblyId, role, key) => Array.from(rootEl.querySelectorAll(`[data-part-assembly="${assemblyId}"][data-part-role="${role}"]`)).filter((el) => key === undefined || (el.getAttribute('data-part-key') || '') === String(key));
    const keysOf = (assemblyId, role) => Array.from(new Set(parts(assemblyId, role).map((el) => el.getAttribute('data-part-key') || ''))).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));

    function env(id) {
      return {
        id, entry: obj(assemblies()[id]), config: obj(obj(assemblies()[id]).config), state: () => state,
        parts: (role, key) => parts(id, role, key), keys: (role) => keysOf(id, role),
        setText, setMoney, setImage, fitLine, money, readonly: opts.readonly === true,
        focus: () => focus,
        /** Open the details of an option ({ group, option }), or close them (null). The same one again closes. */
        setFocus(target) { focus = target && !(focus && focus.option === target.option && focus.group === target.group) ? target : null; render(); },
        input, navigate: (target) => { try { opts.navigate?.(target); } catch (e) { /* host navigation */ } }
      };
    }
    function render() {
      if (destroyed) return;
      for (const id of Object.keys(assemblies())) {
        const def = get(assemblies()[id].type);
        try { def?.render?.(env(id)); } catch (e) { /* one widget must not blank the slide */ }
      }
    }
    /** Apply the click at once, then take the host's answer as the truth. */
    let latest = 0;
    let confirmed = null;
    async function input(change, optimistic) {
      if (opts.readonly === true) return;
      const ticket = ++latest;
      if (confirmed === null) confirmed = state;
      if (typeof optimistic === 'function') { state = optimistic(JSON.parse(JSON.stringify(state))); render(); }
      try {
        const next = await opts.onInput?.(change);
        if (next && typeof next === 'object') confirmed = next;
      } catch (error) {
        try { opts.onError?.(error, change); } catch (e) { /* host callback */ }
      }
      // While a newer click is still on its way, what is on screen stays as clicked.
      if (ticket !== latest) return;
      if (confirmed) state = confirmed;
      confirmed = null;
      render();
    }
    function onClick(event) {
      const el = event.target.closest?.('[data-part-assembly]');
      if (!el || !rootEl.contains(el)) return;
      // The click may land on a part inside the clickable part (a title in an option).
      for (let node = el; node && rootEl.contains(node); node = node.parentElement?.closest('[data-part-assembly]')) {
        const id = node.getAttribute('data-part-assembly');
        const def = get(obj(assemblies()[id]).type);
        if (def?.click?.(env(id), node.getAttribute('data-part-role'), node.getAttribute('data-part-key') || '', event)) { event.preventDefault(); return; }
      }
    }
    function onKey(event) {
      if (event.key === 'Escape' && focus) { focus = null; render(); event.stopPropagation(); return; }
      if ((event.key !== 'Enter' && event.key !== ' ') || !event.target.matches?.('[data-part-role="option"],[data-part-role="review.edit"],[data-part-role="row.option"],[data-part-role="option.more"],[data-part-role="row.option.info"],[data-part-role="detail.close"]')) return;
      event.preventDefault();
      event.stopPropagation();
      event.target.click();
    }
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('keydown', onKey);
    applyTextures(rootEl, opts.document);
    render();
    return {
      state: () => state,
      /** Close whatever details are open; true when something was. */
      closeDetails() { if (!focus) return false; focus = null; render(); return true; },
      /** New state from outside (another device changed a choice), or the same assemblies in a re-rendered DOM. */
      update(next) {
        if (next && next.document) opts.document = next.document;
        if (next && next.state) state = obj(next.state);
        render();
      },
      destroy() { destroyed = true; rootEl.removeEventListener('click', onClick); rootEl.removeEventListener('keydown', onKey); }
    };
  }

  // ---------------------------------------------------------------- types
  // Estimates namespace a group per scope piece ("piece_x:shingle_profile"); a
  // slide names the group itself, so the same deck fits any estimate.
  const groupOf = (state, id) => obj(arr(obj(state).groups).find((group) => text(obj(group).id) === text(id))
    || arr(obj(state).groups).find((group) => text(obj(group).id).split(':').pop() === text(id)));

  /**
   * The live state for a presentation instance as the server returns it
   * (/v1/document-modules/.../presentations/:id), in the shape the parts read.
   */
  function stateFromPresentation(presentation) {
    const p = obj(presentation);
    const offered = obj(p.offered);
    const totals = obj(obj(p.pricing).totals);
    const option = (entry) => ({
      id: text(obj(entry).id), title: text(obj(entry).title || obj(entry).name), description: text(obj(entry).description),
      image_url: text(obj(entry).image_url), swatch: text(obj(entry).swatch), color: text(obj(entry).color_hex), details: text(obj(entry).details), price_cents: Number(obj(entry).price_cents) || 0,
      delta_cents: Number(obj(entry).delta_cents) || 0, selected: obj(entry).selected === true
    });
    const deposit = arr(obj(p.pricing).schedule).filter((entry) => obj(entry).due_rule === 'on_signature').reduce((sum, entry) => sum + (Number(obj(entry).amount_cents) || 0), 0);
    const total = Number(totals.total_cents) || 0;
    return {
      revision: Number(p.revision) || 0,
      readonly: p.frozen === true || p.access === 'view',
      groups: arr(offered.groups).map((group) => ({ id: text(obj(group).id), title: text(obj(group).label), options: arr(obj(group).options).filter((entry) => obj(entry).offered !== false).map(option) })),
      addons: arr(offered.optional).map(option),
      variants: arr(offered.variants),
      totals: { subtotal_cents: Number(totals.subtotal_cents) || 0, tax_cents: Number(totals.tax_cents) || 0, total_cents: total, deposit_cents: deposit, balance_cents: total - deposit },
      values: {}
    };
  }
  /** The server write for a part's input: the body of PATCH .../inputs (without expectedRevision). */
  function inputWrite(input) {
    const change = obj(input);
    if (change.type === 'choice') return { input: 'selections', value: { group_id: text(change.group_id || change.group), item_id: text(change.option) } };
    if (change.type === 'addon') return { input: 'selections', value: { item_id: text(change.addon), selected: change.selected === true } };
    return null;
  }

  /** The options an assembly shows: a choice group's alternatives, or the add-ons. */
  function optionsFor(e) {
    const source = obj(e.config.source);
    if (source.kind === 'addons') return { multiple: true, title: 'Add-ons', options: arr(e.state().addons) };
    const group = groupOf(e.state(), source.id);
    return { multiple: false, group: text(source.id), title: text(group.title), options: arr(group.options) };
  }

  /** Report a pick: one of a group, or an add-on on or off. */
  function choose(e, source, option, presented) {
    if (source.multiple) {
      e.input({ type: 'addon', addon: option.id, selected: !option.selected, presented }, (state) => {
        arr(state.addons).forEach((entry) => { if (entry.id === option.id) entry.selected = !option.selected; });
        return state;
      });
    } else if (!option.selected) {
      e.input({ type: 'choice', group: source.group, group_id: text(groupOf(e.state(), source.group).id), option: option.id, presented }, (state) => {
        arr(groupOf(state, source.group).options).forEach((entry) => { entry.selected = entry.id === option.id; });
        return state;
      });
    }
  }
  /** An option's picture: its photo, else a texture of its kind in its color. */
  function optionBackground(option, kind, index) {
    return text(option.swatch) || textureBackground(kind, option.color, index);
  }
  /** Every option on offer, with where it belongs: [{ option, group, kind, multiple, index }]. */
  function allOptions(state) {
    const out = [];
    arr(obj(state).groups).forEach((group) => arr(obj(group).options).forEach((option, index) => out.push({ option, group: text(group.id), title: text(group.title), kind: textureKind(group.id), multiple: false, index })));
    arr(obj(state).addons).forEach((option, index) => out.push({ option, group: 'addons', title: 'Add-ons', kind: '', multiple: true, index }));
    return out;
  }

  const OPTION_REQUIRED = [{ role: 'option', min: 1 }, { role: 'option.title', per: 'option' }, { role: 'option.price', per: 'option' }];
  const INK = '#101828';
  const MUTED = '#667085';

  /** One option card: swatch or photo, title, description, price and the selected mark. */
  function optionCard(h, key, x, y, w, ht, layout) {
    const pad = 12;
    const children = [];
    if (layout === 'panel') {
      const imageH = Math.round(ht * 0.52);
      children.push(h.box('Photo', 0, 0, w, imageH, { fill: '#d9dde5', radius: 0, role: 'option.image', key, clip: true }));
      children.push(h.text('Name', pad + 2, imageH + 14, w - pad * 2 - 4, 26, 'Option name', { size: 16, weight: 700, color: INK, role: 'option.title', key }));
      children.push(h.text('Description', pad + 2, imageH + 42, w - pad * 2 - 4, ht - imageH - 96, 'A short description of this option.', { size: 10, color: MUTED, line_height: 1.4, role: 'option.description', key }));
      children.push(h.text('Price', pad + 2, ht - 42, w - pad * 2 - 34, 28, '$0', { size: 19, weight: 800, color: INK, role: 'option.price', key }));
      children.push(h.box('Selected mark', w - pad - 24, ht - 40, 22, 22, { fill: 'var(--fm-primary)', radius: 11, role: 'option.mark', key }));
    } else if (layout === 'line') {
      children.push(h.box('Selected mark', pad, (ht - 12) / 2, 12, 12, { fill: 'var(--fm-primary)', radius: 6, role: 'option.mark', key }));
      children.push(h.text('Name', pad + 22, (ht - 18) / 2, w - 150, 18, 'Option name', { size: 11.5, weight: 600, color: INK, role: 'option.title', key }));
      children.push(h.text('Price', w - 110, (ht - 18) / 2, 110 - pad, 18, '$0', { size: 11.5, weight: 700, color: INK, align: 'right', role: 'option.price', key }));
    } else {
      const swatch = Math.min(84, Math.round(w * 0.28));
      children.push(h.box('Photo', pad, pad, swatch, ht - pad * 2, { fill: '#d9dde5', radius: 8, role: 'option.image', key, clip: true }));
      const left = pad * 2 + swatch + 2;
      const wide = w - left - pad;
      children.push(h.text('Name', left, pad + 2, wide - 22, 18, 'Option name', { size: 12.5, weight: 700, color: INK, role: 'option.title', key }));
      children.push(h.text('Description', left, pad + 24, wide, Math.max(14, ht - pad * 2 - 56), 'A short description of this option.', { size: 9, color: MUTED, line_height: 1.4, role: 'option.description', key }));
      children.push(h.text('Price', left, ht - pad - 24, wide, 24, '$0', { size: 16, weight: 800, color: INK, role: 'option.price', key }));
      children.push(h.box('Selected mark', w - pad - 16, pad + 2, 16, 16, { fill: 'var(--fm-primary)', radius: 8, role: 'option.mark', key }));
      children.push(h.box('Details', w - pad - 58, ht - pad - 22, 58, 22, { fill: '#f2f4f7', radius: 11, role: 'option.more', key, children: [
        h.text('Details label', 0, 4.5, 58, 13, 'Details', { size: 8.5, weight: 700, color: INK, align: 'center' })
      ] }));
    }
    return h.box('Option ' + (Number(key) + 1), x, y, w, ht, {
      fill: '#ffffff', radius: layout === 'line' ? 9 : 14, stroke: '#e4e7ec', group: true, clip: layout === 'panel', role: 'option', key, children,
      shadow: layout === 'line' ? null : { x: 0, y: 4, blur: 14, color: 'rgba(16,24,40,.08)' }
    });
  }

  function optionPresets() {
    const count = (o) => Math.max(1, Math.min(8, Number(o.count) || 3));
    return [
      { id: 'stack', label: 'Cards in a column', size: { w: 300, h: 330 }, build(h, o) {
        const n = count(o), gap = 10, top = 38, each = (o.h - top - gap * (n - 1)) / n;
        return [h.text('Heading', 0, 0, o.w, 28, 'Choose an option', { size: 17, weight: 800, color: INK, role: 'title' })]
          .concat(Array.from({ length: n }, (_, i) => optionCard(h, i, 0, top + i * (each + gap), o.w, each, 'card')));
      } },
      { id: 'panels', label: 'Side-by-side panels', size: { w: 840, h: 400 }, build(h, o) {
        const n = count(o), gap = 16, top = 50, each = (o.w - gap * (n - 1)) / n;
        return [h.text('Heading', 0, 0, o.w, 36, 'Choose an option', { size: 24, weight: 800, color: INK, role: 'title' })]
          .concat(Array.from({ length: n }, (_, i) => optionCard(h, i, i * (each + gap), top, each, o.h - top, 'panel')));
      } },
      { id: 'list', label: 'Compact list', size: { w: 320, h: 150 }, build(h, o) {
        const n = count(o), gap = 6, top = 28, each = (o.h - top - gap * (n - 1)) / n;
        return [h.text('Heading', 0, 0, o.w, 20, 'Choose an option', { size: 12, weight: 800, color: INK, role: 'title' })]
          .concat(Array.from({ length: n }, (_, i) => optionCard(h, i, 0, top + i * (each + gap), o.w, each, 'line')));
      } }
    ];
  }

  register('choice_selection', {
    title: 'Selection',
    icon: 'fa-hand-pointer',
    description: 'Options the customer picks between. Each shows its name and price; choosing one deselects the others.',
    defaults: { source: { kind: 'group', id: '' }, price: 'option' },
    required: OPTION_REQUIRED,
    roles: {
      title: 'Heading', option: 'Option', 'option.title': 'Option name', 'option.price': 'Option price',
      'option.description': 'Option description', 'option.image': 'Option photo', 'option.mark': 'Selected mark', 'option.more': 'Details button'
    },
    presets: optionPresets(),
    render(e) {
      const { options, title, multiple, group } = optionsFor(e);
      const looking = (option) => !!e.focus() && e.focus().option === text(option.id);
      e.parts('title').forEach((el) => { if (title && e.config.keep_title !== true) e.setText(el, title); });
      const chosen = options.find((option) => obj(option).selected);
      e.keys('option').forEach((key, index) => {
        const option = obj(options[index]);
        const has = !!text(option.id);
        const each = (role, fn) => e.parts(role, key).forEach((el) => { el.toggleAttribute('data-part-empty', !has); if (has) fn(el); });
        each('option', (el) => {
          el.toggleAttribute('data-part-selected', !!option.selected);
          el.toggleAttribute('data-part-focus', looking(option));
          el.setAttribute('role', multiple ? 'checkbox' : 'radio');
          el.setAttribute('aria-checked', option.selected ? 'true' : 'false');
          el.setAttribute('aria-label', `${text(option.title)}, ${money(option.price_cents)}`);
          if (!e.readonly) el.tabIndex = 0;
        });
        each('option.title', (el) => e.setText(el, option.title));
        each('option.description', (el) => e.setText(el, option.description));
        each('option.image', (el) => e.setImage(el, option.image_url, optionBackground(option, text(e.config.texture) || textureKind(group), index)));
        each('option.more', (el) => { el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'More about ' + text(option.title)); el.setAttribute('aria-expanded', looking(option) ? 'true' : 'false'); });
        each('option.mark', (el) => el.toggleAttribute('data-part-selected', !!option.selected));
        // "difference": what choosing this one adds to or takes off the current price.
        each('option.price', (el) => {
          if (e.config.price === 'difference' && !multiple && chosen) {
            const delta = (Number(option.price_cents) || 0) - (Number(chosen.price_cents) || 0);
            e.setText(el, option.selected ? 'Included' : money(delta, { sign: true }));
          } else e.setText(el, (multiple ? '+' : '') + money(option.price_cents));
          e.fitLine(el);
        });
      });
    },
    click(e, role, key) {
      if (role !== 'option' && role !== 'option.more') return false;
      const source = optionsFor(e);
      const index = e.keys('option').indexOf(key);
      const option = obj(source.options[index]);
      if (!text(option.id)) return false;
      if (role === 'option.more') { e.setFocus({ group: source.multiple ? 'addons' : text(groupOf(e.state(), source.group).id), option: text(option.id) }); return true; }
      choose(e, source, option, e.keys('option').map((_, i) => text(obj(source.options[i]).id)).filter(Boolean));
      return true;
    }
  });

  register('price_display', {
    title: 'Price',
    icon: 'fa-dollar-sign',
    description: 'A live amount from the estimate: the total, the deposit, or the price of one selection.',
    defaults: { source: 'total' },
    required: ['value'],
    roles: { value: 'Amount', label: 'Label' },
    presets: [
      { id: 'large', label: 'Large total', size: { w: 300, h: 92 }, build: (h, o) => [
        h.text('Label', 0, 0, o.w, 18, 'Your total', { size: 10.5, weight: 700, color: MUTED, role: 'label' }),
        h.text('Amount', 0, 20, o.w, 66, '$0', { size: 46, weight: 800, color: INK, role: 'value' })
      ] },
      { id: 'inline', label: 'Label and amount', size: { w: 260, h: 26 }, build: (h, o) => [
        h.text('Label', 0, 4, o.w * 0.55, 18, 'Total', { size: 11.5, weight: 600, color: MUTED, role: 'label' }),
        h.text('Amount', o.w * 0.45, 0, o.w * 0.55, 24, '$0', { size: 15, weight: 800, color: INK, align: 'right', role: 'value' })
      ] }
    ],
    render(e) {
      const state = e.state();
      const source = text(e.config.source) || 'total';
      let cents = null;
      if (source.startsWith('group:')) cents = obj(arr(groupOf(state, source.slice(6)).options).find((option) => obj(option).selected)).price_cents;
      else cents = obj(state.totals)[source + '_cents'] ?? obj(state.values)[source];
      if (cents === null || cents === undefined) return;
      e.parts('value').forEach((el) => e.setMoney(el, cents, { whole: e.config.cents !== true }));
    }
  });

  register('selection_review', {
    title: 'Selections review',
    icon: 'fa-list-check',
    description: 'What was chosen for each selection, with a way back to change it.',
    defaults: {},
    required: [{ role: 'review.row', min: 1 }, { role: 'review.value', per: 'review.row' }],
    roles: { 'review.row': 'Row', 'review.label': 'Selection name', 'review.value': 'Chosen option', 'review.price': 'Price', 'review.edit': 'Change button' },
    presets: [
      { id: 'rows', label: 'Rows', size: { w: 440, h: 176 }, build(h, o) {
        const n = Math.max(1, Math.min(8, Number(o.count) || 4)), gap = 8, each = (o.h - gap * (n - 1)) / n;
        return Array.from({ length: n }, (_, i) => h.box('Row ' + (i + 1), 0, i * (each + gap), o.w, each, {
          fill: '#ffffff', radius: 10, stroke: '#e4e7ec', group: true, role: 'review.row', key: i, children: [
            h.text('Selection', 14, (each - 30) / 2, 120, 14, 'Selection', { size: 8, weight: 700, color: MUTED, role: 'review.label', key: i }),
            h.text('Chosen', 14, (each - 30) / 2 + 13, o.w - 200, 18, 'Chosen option', { size: 11.5, weight: 700, color: INK, role: 'review.value', key: i }),
            h.text('Price', o.w - 178, (each - 18) / 2, 92, 18, '$0', { size: 11.5, weight: 700, color: INK, align: 'right', role: 'review.price', key: i }),
            h.box('Change', o.w - 74, (each - 22) / 2, 60, 22, { fill: '#f2f4f7', radius: 11, role: 'review.edit', key: i, children: [
              h.text('Change label', 0, 4, 60, 14, 'Change', { size: 8.5, weight: 700, color: INK, align: 'center' })
            ] })
          ]
        }));
      } }
    ],
    rows(e) {
      const state = e.state();
      const groups = arr(state.groups).map((group) => {
        const chosen = obj(arr(obj(group).options).find((option) => obj(option).selected));
        return { target: { group: text(group.id) }, label: text(group.title), value: text(chosen.title) || 'Not chosen', price_cents: chosen.price_cents };
      });
      const addons = arr(state.addons).filter((addon) => obj(addon).selected);
      if (arr(state.addons).length) groups.push({
        target: { addons: true }, label: 'Add-ons', value: addons.length ? addons.map((addon) => text(addon.title)).join(', ') : 'None',
        price_cents: addons.reduce((sum, addon) => sum + (Number(addon.price_cents) || 0), 0)
      });
      return groups;
    },
    render(e) {
      const rows = this.rows(e);
      e.keys('review.row').forEach((key, index) => {
        const row = rows[index];
        const each = (role, fn) => e.parts(role, key).forEach((el) => { el.toggleAttribute('data-part-empty', !row); if (row) fn(el); });
        each('review.row', () => {});
        each('review.label', (el) => e.setText(el, row.label));
        each('review.value', (el) => e.setText(el, row.value));
        each('review.price', (el) => { e.setText(el, money(row.price_cents)); e.fitLine(el); });
        each('review.edit', (el) => { el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'Change ' + row.label); });
      });
    },
    click(e, role, key) {
      if (role !== 'review.edit') return false;
      const row = this.rows(e)[e.keys('review.row').indexOf(key)];
      if (row) e.navigate(row.target);
      return !!row;
    }
  });

  // The details of whichever option is being looked at. It is laid out
  // wherever the author wants it and shows only while something is open:
  // config.source = { kind: "group", id } listens to one selection,
  // { kind: "any" } to all of them.
  register('detail_panel', {
    title: 'Option details',
    icon: 'fa-circle-info',
    description: 'More about one option, opened from a Details button and closed again. Shows only while open.',
    defaults: { source: { kind: 'any' } },
    required: ['detail', { role: 'detail.title', per: 'detail' }],
    roles: { detail: 'Panel', 'detail.title': 'Name', 'detail.kicker': 'Selection name', 'detail.body': 'Description', 'detail.image': 'Photo', 'detail.price': 'Price', 'detail.close': 'Close button' },
    presets: [
      { id: 'wide', label: 'Photo beside text', size: { w: 480, h: 250 }, build: (h, o) => {
        const image = Math.round(o.w * 0.36);
        return [h.box('Panel', 0, 0, o.w, o.h, { fill: '#ffffff', radius: 16, stroke: '#e4e7ec', clip: true, role: 'detail', shadow: { x: 0, y: 16, blur: 40, color: 'rgba(16,24,40,.18)' }, children: [
          h.box('Photo', 0, 0, image, o.h, { fill: '#d9dde5', role: 'detail.image', clip: true }),
          h.text('Selection', image + 22, 22, o.w - image - 70, 14, 'SELECTION', { size: 8, weight: 800, color: 'var(--fm-primary)', role: 'detail.kicker' }),
          h.text('Name', image + 22, 40, o.w - image - 44, 28, 'Option name', { size: 19, weight: 800, color: INK, role: 'detail.title' }),
          h.text('Description', image + 22, 76, o.w - image - 44, o.h - 136, 'What this option is, why someone would choose it, and how it differs from the others.', { size: 10.5, color: '#475467', line_height: 1.5, role: 'detail.body' }),
          h.text('Price', image + 22, o.h - 48, o.w - image - 44, 28, '$0', { size: 19, weight: 800, color: INK, role: 'detail.price' }),
          h.box('Close', o.w - 38, 12, 26, 26, { fill: '#f2f4f7', radius: 13, role: 'detail.close', children: [h.text('Close mark', 0, 5, 26, 16, '\u2715', { size: 10, weight: 700, color: INK, align: 'center' })] })
        ] })];
      } },
      { id: 'tall', label: 'Photo above text', size: { w: 288, h: 428 }, build: (h, o) => {
        const image = Math.round(o.h * 0.36);
        return [h.box('Panel', 0, 0, o.w, o.h, { fill: '#ffffff', radius: 22, stroke: '#e4e7ec', clip: true, role: 'detail', shadow: { x: 0, y: 18, blur: 44, color: 'rgba(16,24,40,.22)' }, children: [
          h.box('Photo', 0, 0, o.w, image, { fill: '#d9dde5', role: 'detail.image', clip: true }),
          h.text('Selection', 26, image + 20, o.w - 52, 14, 'SELECTION', { size: 8, weight: 800, color: 'var(--fm-primary)', role: 'detail.kicker' }),
          h.text('Name', 26, image + 38, o.w - 52, 48, 'Option name', { size: 18, weight: 800, color: INK, line_height: 1.15, role: 'detail.title' }),
          h.text('Description', 26, image + 92, o.w - 52, o.h - image - 156, 'What this option is, why someone would choose it, and how it differs from the others.', { size: 10.5, color: '#475467', line_height: 1.5, role: 'detail.body' }),
          h.text('Price', 26, o.h - 52, o.w - 52, 28, '$0', { size: 20, weight: 800, color: INK, role: 'detail.price' }),
          h.box('Close', o.w - 40, 14, 26, 26, { fill: 'rgba(255,255,255,.92)', radius: 13, role: 'detail.close', children: [h.text('Close mark', 0, 5, 26, 16, '\u2715', { size: 10, weight: 700, color: INK, align: 'center' })] })
        ] })];
      } }
    ],
    render(e) {
      const source = obj(e.config.source);
      const looking = e.focus();
      const match = looking && (source.kind !== 'group' || text(looking.group) === text(source.id) || text(looking.group).split(':').pop() === text(source.id))
        ? allOptions(e.state()).find((entry) => text(entry.option.id) === looking.option && (entry.group === looking.group || entry.group.split(':').pop() === text(looking.group).split(':').pop())) : null;
      e.parts('detail').forEach((el) => {
        el.setAttribute('data-part-live', '');
        el.toggleAttribute('data-part-open', !!match);
        el.setAttribute('aria-hidden', match ? 'false' : 'true');
        // The group it was inserted in is only a holder: a closed panel must not catch clicks meant for what is under it.
        const holder = el.parentElement;
        if (holder && holder.matches('.fmdoc-frame') && !holder.hasAttribute('data-part-assembly')) holder.style.pointerEvents = 'none';
      });
      if (!match) return;
      e.parts('detail.kicker').forEach((el) => e.setText(el, match.title.toUpperCase()));
      e.parts('detail.title').forEach((el) => e.setText(el, match.option.title));
      e.parts('detail.body').forEach((el) => e.setText(el, text(match.option.details) || text(match.option.description)));
      e.parts('detail.price').forEach((el) => { e.setText(el, (match.multiple ? '+' : '') + money(match.option.price_cents)); e.fitLine(el); });
      e.parts('detail.image').forEach((el) => e.setImage(el, match.option.image_url, optionBackground(match.option, match.kind, match.index)));
      e.parts('detail.close').forEach((el) => { el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'Close details'); });
    },
    click(e, role) {
      if (role !== 'detail.close') return false;
      e.setFocus(null);
      return true;
    }
  });

  // The whole estimate as rows of alternatives: every selection side by side,
  // changed on the spot. A row is one selection; its options show what each
  // would add to or take off the price.
  register('estimate_compare', {
    title: 'Estimate comparison',
    icon: 'fa-table-columns',
    description: 'Every selection on one slide, with its alternatives beside it. Click one to switch and the price follows.',
    defaults: {},
    required: [{ role: 'row', min: 1 }, { role: 'row.option.title', per: 'row.option' }, { role: 'row.option.price', per: 'row.option' }],
    roles: { row: 'Row', 'row.label': 'Selection name', 'row.option': 'Alternative', 'row.option.title': 'Alternative name', 'row.option.price': 'Price difference', 'row.option.info': 'Details button' },
    presets: [
      { id: 'rows', label: 'Rows of alternatives', size: { w: 500, h: 300 }, build(h, o) {
        const rows = Math.max(1, Math.min(8, Number(o.count) || 4)), per = Math.max(2, Math.min(4, Number(o.options) || 3));
        const gap = 8, each = (o.h - gap * (rows - 1)) / rows, label = 92, chipGap = 6, chip = (o.w - label - chipGap * (per - 1)) / per;
        return Array.from({ length: rows }, (_, i) => h.box('Row ' + (i + 1), 0, i * (each + gap), o.w, each, { group: true, role: 'row', key: i, children: [
          h.text('Selection', 0, (each - 14) / 2, label - 8, 14, 'Selection', { size: 9, weight: 800, color: MUTED, role: 'row.label', key: i })
        ].concat(Array.from({ length: per }, (_, j) => h.box('Alternative ' + (j + 1), label + j * (chip + chipGap), 0, chip, each, { fill: '#ffffff', radius: 10, stroke: '#e4e7ec', group: true, role: 'row.option', key: i + '.' + j, children: [
          h.text('Name', 10, Math.max(6, each / 2 - 17), chip - 34, 15, 'Alternative', { size: 9.5, weight: 700, color: INK, role: 'row.option.title', key: i + '.' + j }),
          h.text('Difference', 10, Math.max(22, each / 2 + 1), chip - 20, 15, '$0', { size: 10.5, weight: 800, color: INK, role: 'row.option.price', key: i + '.' + j }),
          h.box('Details', chip - 24, 6, 17, 17, { fill: '#f2f4f7', radius: 9, role: 'row.option.info', key: i + '.' + j, children: [h.text('Details mark', 0, 2.5, 17, 12, 'i', { size: 8.5, weight: 800, color: MUTED, align: 'center' })] })
        ] }))) }));
      } }
    ],
    rows(e) {
      const state = e.state();
      const rows = arr(state.groups).map((group) => ({ group: text(group.id), title: text(group.title), multiple: false, options: arr(group.options) }));
      if (arr(state.addons).length) rows.push({ group: 'addons', title: 'Add-ons', multiple: true, options: arr(state.addons) });
      return rows;
    },
    slot(key) { const [row, option] = text(key).split('.'); return { row: Number(row), option: option === undefined ? -1 : Number(option) }; },
    render(e) {
      const rows = this.rows(e);
      const looking = e.focus();
      e.keys('row').forEach((key, index) => {
        const row = rows[index];
        e.parts('row', key).forEach((el) => el.toggleAttribute('data-part-empty', !row));
        e.parts('row.label', key).forEach((el) => { el.toggleAttribute('data-part-empty', !row); if (row) e.setText(el, row.title); });
      });
      const rowKeys = e.keys('row');
      for (const role of ['row.option', 'row.option.title', 'row.option.price', 'row.option.info']) {
        e.parts(role).forEach((el) => {
          const at = this.slot(el.getAttribute('data-part-key'));
          const row = rows[rowKeys.indexOf(String(at.row))];
          const option = obj(row && row.options[at.option]);
          const has = !!text(option.id);
          el.toggleAttribute('data-part-empty', !has);
          if (!has) return;
          const chosen = row.multiple ? null : obj(row.options.find((entry) => obj(entry).selected));
          if (role === 'row.option') {
            el.toggleAttribute('data-part-selected', !!option.selected);
            el.toggleAttribute('data-part-focus', !!looking && looking.option === text(option.id));
            el.setAttribute('role', row.multiple ? 'checkbox' : 'radio');
            el.setAttribute('aria-checked', option.selected ? 'true' : 'false');
            el.setAttribute('aria-label', `${row.title}: ${text(option.title)}`);
            if (!e.readonly) el.tabIndex = 0;
          } else if (role === 'row.option.title') e.setText(el, option.title);
          else if (role === 'row.option.price') {
            if (row.multiple) e.setText(el, '+' + money(option.price_cents));
            else if (option.selected) e.setText(el, money(option.price_cents));
            else { const delta = (Number(option.price_cents) || 0) - (Number(chosen.price_cents) || 0); e.setText(el, delta ? money(delta, { sign: true }) : 'Same price'); }
            e.fitLine(el);
          } else { el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'More about ' + text(option.title)); }
        });
      }
    },
    click(e, role, key) {
      if (role !== 'row.option' && role !== 'row.option.info') return false;
      const at = this.slot(key);
      const row = this.rows(e)[e.keys('row').indexOf(String(at.row))];
      const option = obj(row && row.options[at.option]);
      if (!text(option.id)) return false;
      if (role === 'row.option.info') { e.setFocus({ group: row.group, option: text(option.id) }); return true; }
      choose(e, { multiple: row.multiple, group: row.group }, option, row.options.map((entry) => text(obj(entry).id)).filter(Boolean));
      return true;
    }
  });

  /** True when a page's selections all have nothing to offer in this state (a slide to pass over). */
  function pageIsEmpty(doc, pageId, state) {
    const M = model();
    const ids = new Set(M.assemblyParts(doc, null, []).filter((part) => part.page && part.page.id === pageId).map((part) => part.assembly));
    const selections = Array.from(ids).map((id) => obj(obj(obj(doc).assemblies)[id])).filter((entry) => entry.type === 'choice_selection');
    if (!selections.length) return false;
    return selections.every((entry) => !optionsFor({ config: obj(entry.config), state: () => obj(state) }).options.length);
  }

  /** The page that holds the selection for a review target ({ group } | { addons }). */
  function pageForTarget(doc, target) {
    const M = model();
    const want = obj(target);
    for (const [id, entry] of Object.entries(obj(obj(doc).assemblies))) {
      const source = obj(obj(obj(entry).config).source);
      if (obj(entry).type !== 'choice_selection') continue;
      if (!((want.addons && source.kind === 'addons') || (want.group && source.kind !== 'addons' && (text(source.id) === text(want.group) || text(source.id) === text(want.group).split(':').pop())))) continue;
      const part = M.assemblyParts(doc, id, [])[0];
      if (part && part.page) return part.page.id;
    }
    return '';
  }

  return { register, get, list, build, insert, attach, money, pageForTarget, pageIsEmpty, stateFromPresentation, inputWrite, texture, textureKind, applyTextures };
});
