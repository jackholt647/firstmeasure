/**
 * FMDocPresent — plays a paged DocModel as a slideshow.
 *
 * A presentation is an ordinary paged document (usually a 16:9 paper size)
 * whose pages carry two optional, additive fields:
 *
 *   page.transition = { type, duration_ms?, easing?, direction? }
 *     How this slide arrives. Types: FMDocPresent.TRANSITIONS.
 *     "morph" moves nodes that also exist on the previous slide (same
 *     props.morph_key, else same name) from where they were to where they
 *     are, and fades the rest — so "the diagram slides left" is two slides
 *     with the diagram in two places, not a hand-built animation.
 *
 *   page.steps = [{ id, name?, auto?, actions: [{ node, effect, duration_ms?, delay_ms?, easing?, direction? }] }]
 *     What happens on each advance before the slide changes. All actions of
 *     one step play together. Effects: FMDocPresent.EFFECTS. A node whose
 *     first action is an entrance starts the slide hidden. An `auto` step
 *     plays by itself after the one before it (or after the slide arrives).
 *
 *   node.props.action = { type: "next" | "back" | "first" | "goto" | "custom", page?, name? }
 *     Makes any node a button while presenting. "custom" is handed to the
 *     host (opts.onAction) — sign, send to the customer, and so on.
 *
 * With opts.live = { state, onInput } the slides' assemblies (FMDocParts —
 * selections, prices, the review) are wired to that state.
 *
 * Nothing here is specific to a kind of presentation: widgets on the slides
 * (prices, selections, signature) are ordinary document widgets and keep
 * working because the pages are rendered by FMDocRenderer in interactive mode.
 *
 *   const player = FMDocPresent.mount(container, {
 *     document, theme, themeContext, widgetData, widgetContext, mediaUrl, orgId,
 *     start: { page, step }, controls: true, onNavigate, onExit
 *   });
 *   player.next() / back() / goTo(pageIndex, stepIndex) / position()
 *   player.update({ widgetData, widgetContext })   // re-render in place
 *   player.fullscreen() / destroy()
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FMDocPresent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const TRANSITIONS = [
    { id: 'none', label: 'None' },
    { id: 'fade', label: 'Fade' },
    { id: 'slide', label: 'Slide', directional: true },
    { id: 'push', label: 'Push', directional: true },
    { id: 'zoom', label: 'Zoom' },
    { id: 'morph', label: 'Match & move' }
  ];
  // kind: enter (hidden before), exit (hidden after), emphasis (plays and
  // returns), state (stays until its opposite).
  const EFFECTS = [
    { id: 'fade_in', label: 'Fade in', kind: 'enter' },
    { id: 'rise', label: 'Rise', kind: 'enter' },
    { id: 'slide_in', label: 'Slide in', kind: 'enter', directional: true },
    { id: 'zoom_in', label: 'Zoom in', kind: 'enter' },
    { id: 'wipe', label: 'Wipe', kind: 'enter', directional: true },
    { id: 'draw', label: 'Draw line', kind: 'enter' },
    { id: 'fade_out', label: 'Fade out', kind: 'exit' },
    { id: 'slide_out', label: 'Slide out', kind: 'exit', directional: true },
    { id: 'zoom_out', label: 'Zoom out', kind: 'exit' },
    { id: 'pulse', label: 'Pulse', kind: 'emphasis' },
    { id: 'highlight', label: 'Highlight', kind: 'state', flag: 'highlight', value: true },
    { id: 'unhighlight', label: 'Remove highlight', kind: 'state', flag: 'highlight', value: false },
    { id: 'dim', label: 'Dim', kind: 'state', flag: 'dim', value: true },
    { id: 'undim', label: 'Restore', kind: 'state', flag: 'dim', value: false }
  ];
  const EFFECT = Object.fromEntries(EFFECTS.map((effect) => [effect.id, effect]));
  const DIRECTIONS = ['left', 'right', 'up', 'down'];
  const DEFAULT_MS = 500;
  const EASING = 'cubic-bezier(.22,.8,.26,1)';

  const arr = (value) => (Array.isArray(value) ? value : []);
  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const ms = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Number(value), 10000) : fallback);

  /** A page's steps with unknown effects and empty steps dropped. */
  function pageSteps(page) {
    return arr(obj(page).steps).map((step) => ({
      id: String(obj(step).id || ''),
      name: String(obj(step).name || ''),
      auto: obj(step).auto === true,
      actions: arr(obj(step).actions).filter((action) => obj(action).node && EFFECT[obj(action).effect])
    })).filter((step) => step.actions.length);
  }

  function pageTransition(page) {
    const transition = obj(obj(page).transition);
    const type = TRANSITIONS.some((entry) => entry.id === transition.type) ? transition.type : 'none';
    return {
      type,
      duration_ms: ms(transition.duration_ms, type === 'morph' ? 700 : DEFAULT_MS),
      easing: typeof transition.easing === 'string' && transition.easing ? transition.easing : EASING,
      direction: DIRECTIONS.includes(transition.direction) ? transition.direction : 'left'
    };
  }

  /**
   * What each animated node looks like after `stepCount` steps of a page:
   * { [nodeId]: { visible, highlight, dim } }. Pure — the editor uses it to
   * preview a step and the player to jump to one without playing the rest.
   */
  function stateAtStep(page, stepCount) {
    const steps = pageSteps(page);
    const state = {};
    const entry = (id) => (state[id] || (state[id] = { visible: true, highlight: false, dim: false, seen: false }));
    for (const step of steps) for (const action of step.actions) {
      const node = entry(action.node);
      if (!node.seen) { node.seen = true; if (EFFECT[action.effect].kind === 'enter') node.visible = false; }
    }
    steps.slice(0, clamp(stepCount, 0, steps.length)).forEach((step) => step.actions.forEach((action) => {
      const effect = EFFECT[action.effect];
      const node = entry(action.node);
      if (effect.kind === 'enter') node.visible = true;
      else if (effect.kind === 'exit') node.visible = false;
      else if (effect.kind === 'state') node[effect.flag] = effect.value;
    }));
    for (const id of Object.keys(state)) delete state[id].seen;
    return state;
  }

  const STYLE_ID = 'fmdp-styles';
  const CSS = `
.fmdp{position:relative;width:100%;height:100%;min-height:200px;background:#0b0d12;overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:pan-y;outline:none;font-family:var(--fm-body-font,Inter,system-ui,sans-serif)}
.fmdp-stage{position:absolute;left:0;top:0;overflow:hidden;background:#fff;box-shadow:0 20px 70px rgba(0,0,0,.45)}
.fmdp-stage .fmdoc-root{position:absolute;left:0;top:0}
.fmdp-stage .fmdoc-scale{position:relative}
.fmdp-stage .fmdoc-page{position:absolute!important;left:0;top:0;margin:0!important;box-shadow:none!important}
.fmdp-stage .fmdoc-page:not([data-fmdp-on]){visibility:hidden;pointer-events:none}
.fmdp-stage [data-fmdp-hidden]{visibility:hidden!important;pointer-events:none!important}
.fmdp-stage [data-fmdp-dim]{opacity:.22;transition:opacity .45s ease}
.fmdp-stage [data-fmdp-highlight]{filter:drop-shadow(0 0 10px var(--fm-primary,#2563eb)) drop-shadow(0 0 2px var(--fm-primary,#2563eb));transition:filter .45s ease}
.fmdp-top{position:absolute;left:50%;top:0;transform:translate(-50%,-110%);display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:0 0 14px 14px;background:rgba(17,20,28,.86);backdrop-filter:blur(14px);color:#fff;z-index:20;transition:transform .22s ease,visibility 0s .22s;visibility:hidden}
.fmdp[data-controls=on] .fmdp-top{transform:translate(-50%,0);visibility:visible;transition:transform .22s ease;box-shadow:0 8px 30px rgba(0,0,0,.35)}
.fmdp-edge{position:absolute;left:0;right:0;top:0;height:14px;z-index:19}
.fmdp-btn{border:0;background:transparent;color:#e7eaf0;min-width:34px;height:34px;padding:0 9px;border-radius:9px;font:600 12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.fmdp-btn:hover{background:rgba(255,255,255,.14);color:#fff}
.fmdp-btn:disabled{opacity:.35;cursor:default;background:transparent}
.fmdp-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.fmdp-count{font:600 12px/1 inherit;color:#aeb5c2;padding:0 8px;min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.fmdp-sep{width:1px;height:18px;background:rgba(255,255,255,.16);margin:0 3px}
.fmdp-bottom{position:absolute;left:0;right:0;bottom:0;display:flex;gap:4px;padding:14px 18px 10px;z-index:18;opacity:.0;transition:opacity .2s ease;background:linear-gradient(to top,rgba(0,0,0,.5),transparent)}
.fmdp:hover .fmdp-bottom,.fmdp[data-controls=on] .fmdp-bottom,.fmdp-bottom:focus-within{opacity:1}
.fmdp-seg{position:relative;flex:1 1 0;min-width:6px;height:14px;display:flex;align-items:center;gap:2px;border:0;padding:0;background:transparent;cursor:pointer}
.fmdp-seg i{flex:1 1 0;height:4px;border-radius:3px;background:rgba(255,255,255,.28);transition:background .2s ease,height .15s ease}
.fmdp-seg:hover i{height:7px}
.fmdp-seg i[data-done]{background:rgba(255,255,255,.72)}
.fmdp-seg i[data-now]{background:var(--fm-primary,#fff);height:7px}
.fmdp-tip{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(17,20,28,.92);color:#fff;font:600 11px/1 inherit;padding:6px 8px;border-radius:7px;pointer-events:none;opacity:0;transition:opacity .12s ease}
.fmdp-seg:hover .fmdp-tip{opacity:1}
.fmdp-seg:first-child .fmdp-tip{left:0;transform:none}
.fmdp-seg:last-child .fmdp-tip{left:auto;right:0;transform:none}
@media (prefers-reduced-motion:reduce){.fmdp-top,.fmdp-bottom,.fmdp-seg i{transition:none}}
`;
  function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    restart: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  const offset = (direction, distance) => ({
    left: [distance, 0], right: [-distance, 0], up: [0, distance], down: [0, -distance]
  }[DIRECTIONS.includes(direction) ? direction : 'left']);

  function mount(container, options) {
    if (typeof document === 'undefined') throw new Error('FMDocPresent.mount requires a DOM');
    const renderer = root.FMDocRenderer;
    const model = root.FMDocModel;
    if (!renderer || !model) throw new Error('FMDocPresent needs FMDocModel and FMDocRenderer');
    ensureStyles();
    let opts = Object.assign({}, options || {});
    const doc = () => obj(opts.document);
    const pages = () => arr(doc().pages);
    const reduced = () => opts.reducedMotion === true || (opts.reducedMotion !== false && !!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    const time = (value, fallback) => (reduced() ? 0 : ms(value, fallback));

    const el = document.createElement('div');
    el.className = 'fmdp';
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-roledescription', 'presentation');
    const stage = document.createElement('div');
    stage.className = 'fmdp-stage';
    el.appendChild(stage);
    container.appendChild(el);

    let handle = null;
    let destroyed = false;
    let pageIndex = clamp(Number(obj(opts.start).page) || 0, 0, Math.max(0, pages().length - 1));
    let stepIndex = Math.max(0, Number(obj(opts.start).step) || 0);
    let running = [];
    let hideControls = null;
    let autoTimer = null;
    let parts = null;
    let liveState = obj(obj(opts.live).state);
    let actions = new Map();

    // ------------------------------------------------------------- layout
    const paperPx = () => {
      const paper = model.paperDimensions(doc());
      return { w: paper.w_pt * renderer.PT_TO_PX, h: paper.h_pt * renderer.PT_TO_PX };
    };
    function fit() {
      if (destroyed || !handle) return;
      const { w, h } = paperPx();
      const scale = Math.max(0.05, Math.min(el.clientWidth / w, el.clientHeight / h));
      handle.setScale(scale);
      stage.style.width = `${w * scale}px`;
      stage.style.height = `${h * scale}px`;
      stage.style.left = `${(el.clientWidth - w * scale) / 2}px`;
      stage.style.top = `${(el.clientHeight - h * scale) / 2}px`;
      const rootEl = stage.querySelector('.fmdoc-root');
      if (rootEl) { rootEl.style.width = `${w * scale}px`; rootEl.style.height = `${h * scale}px`; }
    }
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    resize?.observe(el);

    const pageEl = (index) => stage.querySelector(`.fmdoc-page[data-page-id="${CSS_ESCAPE(obj(pages()[index]).id)}"]`);
    const nodeEl = (host, id) => host?.querySelector(`[data-node-id="${CSS_ESCAPE(id)}"]`) || null;

    function stop() {
      clearTimeout(autoTimer);
      running.forEach((animation) => { try { animation.finish(); } catch (e) { /* already done */ } });
      running = [];
    }
    function play(target, keyframes, timing) {
      if (!target?.animate || !timing.duration) return null;
      const animation = target.animate(keyframes, { easing: EASING, fill: 'backwards', ...timing });
      running.push(animation);
      animation.finished.catch(() => {}).then(() => { running = running.filter((entry) => entry !== animation); });
      return animation;
    }

    /** Put one slide's nodes in the state they have after `count` steps. */
    function applyState(index, count) {
      const host = pageEl(index);
      if (!host) return;
      const state = stateAtStep(pages()[index], count);
      host.querySelectorAll('[data-fmdp-hidden],[data-fmdp-dim],[data-fmdp-highlight]').forEach((node) => {
        node.removeAttribute('data-fmdp-hidden'); node.removeAttribute('data-fmdp-dim'); node.removeAttribute('data-fmdp-highlight');
      });
      for (const [id, value] of Object.entries(state)) {
        const node = nodeEl(host, id);
        if (!node) continue;
        node.toggleAttribute('data-fmdp-hidden', !value.visible);
        node.toggleAttribute('data-fmdp-dim', value.dim);
        node.toggleAttribute('data-fmdp-highlight', value.highlight);
      }
    }
    function show(index) {
      stage.querySelectorAll('.fmdoc-page[data-fmdp-on]').forEach((node) => node.removeAttribute('data-fmdp-on'));
      pageEl(index)?.setAttribute('data-fmdp-on', '');
    }

    // ---------------------------------------------------------- animation
    function playAction(host, action) {
      const node = nodeEl(host, action.node);
      if (!node) return;
      const duration = time(action.duration_ms, DEFAULT_MS);
      const timing = { duration, delay: time(action.delay_ms, 0), ...(action.easing ? { easing: action.easing } : {}) };
      const distance = Math.max(40, Math.min(node.offsetWidth || 120, 220));
      const [dx, dy] = offset(action.direction, distance);
      const from = (transform) => [{ opacity: 0, transform }, { opacity: 1, transform: 'none' }];
      const to = (transform) => [{ opacity: 1, transform: 'none' }, { opacity: 0, transform }];
      const hideAfter = (animation) => {
        // The node stays visible while its exit plays, then hides.
        node.removeAttribute('data-fmdp-hidden');
        const done = () => node.setAttribute('data-fmdp-hidden', '');
        if (animation) animation.finished.then(done, done); else done();
      };
      switch (action.effect) {
        case 'fade_in': play(node, [{ opacity: 0 }, { opacity: 1 }], timing); break;
        case 'rise': play(node, from('translateY(26px)'), timing); break;
        case 'slide_in': play(node, from(`translate(${dx}px,${dy}px)`), timing); break;
        case 'zoom_in': play(node, from('scale(.86)'), timing); break;
        case 'wipe': {
          const inset = { left: 'inset(0 0 0 100%)', right: 'inset(0 100% 0 0)', up: 'inset(100% 0 0 0)', down: 'inset(0 0 100% 0)' }[DIRECTIONS.includes(action.direction) ? action.direction : 'right'];
          play(node, [{ clipPath: inset }, { clipPath: 'inset(0 0 0 0)' }], timing);
          break;
        }
        case 'draw': {
          // Lines and outlines draw along their path; anything else wipes in.
          const strokes = Array.from(node.querySelectorAll('svg path, svg line, svg polyline, svg polygon, svg rect, svg ellipse, svg circle')).filter((shape) => typeof shape.getTotalLength === 'function');
          if (!strokes.length) { play(node, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], timing); break; }
          strokes.forEach((shape) => {
            let length = 0;
            try { length = shape.getTotalLength(); } catch (e) { length = 0; }
            if (length) play(shape, [{ strokeDasharray: length, strokeDashoffset: length }, { strokeDasharray: length, strokeDashoffset: 0 }], timing);
          });
          play(node, [{ opacity: 0 }, { opacity: 1 }], { ...timing, duration: Math.min(120, duration) });
          break;
        }
        case 'fade_out': hideAfter(play(node, [{ opacity: 1 }, { opacity: 0 }], { ...timing, fill: 'both' })); break;
        case 'slide_out': hideAfter(play(node, to(`translate(${-dx}px,${-dy}px)`), { ...timing, fill: 'both' })); break;
        case 'zoom_out': hideAfter(play(node, to('scale(.86)'), { ...timing, fill: 'both' })); break;
        case 'pulse': play(node, [{ transform: 'none' }, { transform: 'scale(1.06)' }, { transform: 'none' }], timing); break;
        default: break; // state effects are attributes with their own CSS transition
      }
    }

    const matchKey = (node) => String(obj(obj(node).props).morph_key || obj(node).name || '');
    /** Top-level nodes of a slide by match key (first wins). */
    function matchable(index) {
      const map = new Map();
      arr(obj(pages()[index]).children).forEach((node) => {
        const key = matchKey(node);
        if (key && !map.has(key)) map.set(key, node.id);
      });
      return map;
    }

    function transitionTo(from, to, backwards) {
      const incoming = pageEl(to);
      const outgoing = pageEl(from);
      // Going back plays the slide we are leaving in reverse.
      const transition = pageTransition(pages()[backwards ? from : to]);
      const duration = time(transition.duration_ms, DEFAULT_MS);
      show(to);
      if (!incoming || !outgoing || from === to || transition.type === 'none' || !duration) return;
      outgoing.setAttribute('data-fmdp-on', '');
      const done = () => { if (pageIndex !== from) outgoing.removeAttribute('data-fmdp-on'); outgoing.style.zIndex = ''; incoming.style.zIndex = ''; };
      const timing = { duration, easing: transition.easing, fill: 'both' };
      const finish = (animation) => { if (animation) animation.finished.then(() => { animation.cancel(); done(); }, done); else done(); };
      incoming.style.zIndex = '2';
      outgoing.style.zIndex = '1';
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      const [ux, uy] = offset(transition.direction, 1).map((value) => (backwards ? -value : value));
      if (transition.type === 'fade') {
        finish(play(incoming, [{ opacity: 0 }, { opacity: 1 }], timing));
      } else if (transition.type === 'zoom') {
        play(outgoing, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `scale(${backwards ? 0.92 : 1.08})` }], timing)?.finished.then((a) => a.cancel(), () => {});
        finish(play(incoming, [{ opacity: 0, transform: `scale(${backwards ? 1.08 : 0.92})` }, { opacity: 1, transform: 'none' }], timing));
      } else if (transition.type === 'slide' || transition.type === 'push') {
        if (transition.type === 'push') play(outgoing, [{ transform: 'none' }, { transform: `translate(${-ux * w}px,${-uy * h}px)` }], timing)?.finished.then((a) => a.cancel(), () => {});
        finish(play(incoming, [{ transform: `translate(${ux * w}px,${uy * h}px)` }, { transform: 'none' }], timing));
      } else if (transition.type === 'morph') {
        const before = matchable(from);
        const after = matchable(to);
        const moved = new Set();
        let last = null;
        after.forEach((id, key) => {
          const target = nodeEl(incoming, id);
          const source = before.has(key) ? nodeEl(outgoing, before.get(key)) : null;
          if (!target || !source || target.hasAttribute('data-fmdp-hidden') || source.hasAttribute('data-fmdp-hidden')) return;
          const a = source.getBoundingClientRect();
          const b = target.getBoundingClientRect();
          if (!b.width || !b.height) return;
          moved.add(id);
          source.style.visibility = 'hidden';
          const opacity = (element) => Number(getComputedStyle(element).opacity);
          const animation = play(target, [
            { transformOrigin: '0 0', transform: `translate(${a.left - b.left}px,${a.top - b.top}px) scale(${a.width / b.width},${a.height / b.height})`, opacity: opacity(source) },
            { transformOrigin: '0 0', transform: 'none', opacity: opacity(target) }
          ], timing);
          animation?.finished.then(() => { animation.cancel(); source.style.visibility = ''; }, () => { source.style.visibility = ''; });
          last = animation || last;
        });
        // Whatever has no partner fades; the slide backgrounds cross-fade under it.
        arr(obj(pages()[to]).children).forEach((node) => {
          if (moved.has(node.id)) return;
          const target = nodeEl(incoming, node.id);
          const animation = play(target, [{ opacity: 0 }, { opacity: 1 }], { ...timing, delay: duration * 0.25, duration: duration * 0.75 });
          animation?.finished.then(() => animation.cancel(), () => {});
        });
        const fade = play(outgoing, [{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: duration * 0.6 });
        fade?.finished.then(() => fade.cancel(), () => {});
        finish(last || fade);
      }
    }

    // --------------------------------------------------------- navigation
    const stepCount = (index) => pageSteps(pages()[index]).length;
    function position() {
      return { page: pageIndex, step: stepIndex, pages: pages().length, steps: stepCount(pageIndex), page_id: obj(pages()[pageIndex]).id || '' };
    }
    function announce() {
      renderControls();
      try { opts.onNavigate?.(position()); } catch (e) { /* host callback */ }
    }
    /** Where the slide rests at or after `count` steps: auto steps never wait for an advance. */
    function rest(index, count) {
      const steps = pageSteps(pages()[index]);
      let at = clamp(count, 0, steps.length);
      while (at < steps.length && steps[at].auto) at += 1;
      return at;
    }
    function playStep() {
      const steps = pageSteps(pages()[pageIndex]);
      const step = steps[stepIndex];
      if (!step) return;
      stepIndex += 1;
      applyState(pageIndex, stepIndex);
      const host = pageEl(pageIndex);
      step.actions.forEach((action) => playAction(host, action));
      announce();
      if (steps[stepIndex] && steps[stepIndex].auto) {
        const wait = Math.max(0, ...step.actions.map((action) => time(action.duration_ms, DEFAULT_MS) * 0.6 + time(action.delay_ms, 0)));
        autoTimer = setTimeout(playStep, wait);
      }
    }
    function goTo(page, step, { animate = true } = {}) {
      if (destroyed || !pages().length) return;
      const target = clamp(Number(page) || 0, 0, pages().length - 1);
      const steps = pageSteps(pages()[target]);
      const wanted = clamp(step === 'end' ? steps.length : (Number(step) || 0), 0, steps.length);
      stop();
      const from = pageIndex;
      // Details opened on one slide do not follow to the next.
      if (target !== from) parts?.closeDetails();
      // Arriving at the start of a slide plays its opening auto steps; landing
      // anywhere else, or without animation, goes straight to the resting state.
      const opening = animate && wanted === 0 && steps[0] && steps[0].auto && !reduced();
      pageIndex = target;
      stepIndex = opening ? 0 : rest(target, wanted);
      applyState(target, stepIndex);
      if (animate && from !== target) transitionTo(from, target, target < from);
      else show(target);
      announce();
      if (opening) autoTimer = setTimeout(playStep, from !== target ? pageTransition(pages()[target]).duration_ms * 0.7 : 0);
    }
    function next() {
      if (destroyed) return;
      const steps = pageSteps(pages()[pageIndex]);
      stop();
      // An advance during auto steps finishes them first.
      if (stepIndex < steps.length && steps[stepIndex].auto && stepIndex > 0) { stepIndex = rest(pageIndex, stepIndex); applyState(pageIndex, stepIndex); }
      if (stepIndex < steps.length) playStep();
      else if (pageIndex < pages().length - 1) goTo(neighbor(pageIndex, 1), 0);
    }
    function back() {
      if (destroyed) return;
      const steps = pageSteps(pages()[pageIndex]);
      stop();
      if (stepIndex > rest(pageIndex, 0)) {
        let at = stepIndex - 1;
        while (at > 0 && steps[at].auto) at -= 1;
        stepIndex = rest(pageIndex, at);
        applyState(pageIndex, stepIndex);
        announce();
      } else if (pageIndex > 0) goTo(neighbor(pageIndex, -1), 'end');
    }
    /** A slide whose only purpose is a selection with nothing to offer is passed over. */
    const skipped = (index) => !!root.FMDocParts?.pageIsEmpty?.(doc(), obj(pages()[index]).id, parts ? parts.state() : liveState);
    function neighbor(from, direction) {
      let index = from + direction;
      while (index > 0 && index < pages().length - 1 && skipped(index)) index += direction;
      return index;
    }
    /** Jump to the slide holding a selection ({ group } | { addons }) or a page id. */
    function navigate(target) {
      const id = typeof target === 'string' ? target : (root.FMDocParts?.pageForTarget(doc(), target) || '');
      const index = pages().findIndex((page) => page.id === id);
      if (index >= 0) goTo(index, 'end');
    }
    function runAction(action) {
      const type = String(obj(action).type || '');
      if (type === 'next') next();
      else if (type === 'back') back();
      else if (type === 'first') goTo(0, 0);
      else if (type === 'goto') navigate(String(action.page || ''));
      else if (type === 'custom') { try { opts.onAction?.(String(action.name || ''), position(), action); } catch (e) { /* host action */ } }
    }

    // ----------------------------------------------------------- controls
    const controls = opts.controls !== false;
    const edge = document.createElement('div');
    edge.className = 'fmdp-edge';
    const top = document.createElement('div');
    top.className = 'fmdp-top';
    const bottom = document.createElement('div');
    bottom.className = 'fmdp-bottom';
    if (controls) { el.appendChild(edge); el.appendChild(top); el.appendChild(bottom); }

    function revealControls(hold) {
      el.setAttribute('data-controls', 'on');
      clearTimeout(hideControls);
      if (!hold) hideControls = setTimeout(() => { if (!top.matches(':hover')) el.removeAttribute('data-controls'); }, 2600);
    }
    function renderControls() {
      if (!controls) return;
      const at = position();
      const first = at.page === 0 && at.step === 0;
      const last = at.page === at.pages - 1 && at.step === at.steps;
      top.innerHTML = `
        <button type="button" class="fmdp-btn" data-fmdp="back" title="Back (←)" aria-label="Back" ${first ? 'disabled' : ''}>${ICON.back}</button>
        <span class="fmdp-count" aria-live="polite">${at.page + 1} / ${at.pages}</span>
        <button type="button" class="fmdp-btn" data-fmdp="next" title="Next (→)" aria-label="Next" ${last ? 'disabled' : ''}>${ICON.next}</button>
        <span class="fmdp-sep"></span>
        <button type="button" class="fmdp-btn" data-fmdp="restart" title="Start over" aria-label="Start over">${ICON.restart}</button>
        <button type="button" class="fmdp-btn" data-fmdp="full" title="Full screen (F)" aria-label="Full screen">${ICON.full}</button>
        ${arr(opts.actions).map((action, index) => `<button type="button" class="fmdp-btn" data-fmdp-action="${index}" title="${escapeHtml(obj(action).title || obj(action).label)}">${escapeHtml(obj(action).label)}</button>`).join('')}
        <span class="fmdp-sep"></span>
        <button type="button" class="fmdp-btn" data-fmdp="close" title="Close (Esc)" aria-label="Close">${ICON.close}</button>`;
      bottom.innerHTML = pages().map((page, index) => {
        if (skipped(index)) return '';
        // Steps that play by themselves are not places to stop.
        const stops = Array.from(new Set(Array.from({ length: stepCount(index) + 1 }, (_, step) => rest(index, step))));
        const here = index === at.page ? rest(index, at.step) : -1;
        const bars = stops.map((step) => {
          const done = index < at.page || (index === at.page && step < here);
          return `<i data-fmdp-step="${step}" ${step === here ? 'data-now' : (done ? 'data-done' : '')}></i>`;
        }).join('');
        const label = escapeHtml(obj(page).name || `Slide ${index + 1}`);
        return `<button type="button" class="fmdp-seg" data-fmdp-page="${index}" aria-label="${label}" ${index === at.page ? 'aria-current="step"' : ''}>${bars}<span class="fmdp-tip">${label}</span></button>`;
      }).join('');
    }
    function onClick(event) {
      if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
      const button = event.target.closest?.('[data-fmdp],[data-fmdp-action],[data-fmdp-page]');
      if (!button) {
        // A node with props.action is a button on the slide.
        for (let node = event.target.closest?.('[data-node-id]'); node && stage.contains(node); node = node.parentElement?.closest('[data-node-id]')) {
          const action = actions.get(node.getAttribute('data-node-id'));
          if (action) { event.preventDefault(); runAction(action); return; }
        }
        return;
      }
      if (!el.contains(button)) return;
      if (button.dataset.fmdpPage != null) {
        const bar = event.target.closest('[data-fmdp-step]');
        goTo(Number(button.dataset.fmdpPage), bar ? Number(bar.dataset.fmdpStep) : 0, { animate: !bar });
        return;
      }
      if (button.dataset.fmdpAction != null) { try { obj(arr(opts.actions)[Number(button.dataset.fmdpAction)]).run?.(position()); } catch (e) { /* host action */ } return; }
      ({ back, next, restart: () => goTo(0, 0), full: fullscreen, close: exit }[button.dataset.fmdp] || (() => {}))();
    }
    function onKey(event) {
      if (event.defaultPrevented || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      const key = event.key;
      if ((key === 'Enter' || key === ' ') && event.target !== el && event.target.closest?.('[data-part-action],[data-part-assembly],button,a')) {
        if (event.target.matches?.('[data-part-action]')) { event.preventDefault(); event.target.click(); }
        return;
      }
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(key)) { if (key !== 'Enter' || event.target === el) { event.preventDefault(); next(); } }
      else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(key)) { event.preventDefault(); back(); }
      else if (key === 'Home') { event.preventDefault(); goTo(0, 0); }
      else if (key === 'End') { event.preventDefault(); goTo(pages().length - 1, 'end'); }
      else if (key === 'f' || key === 'F') fullscreen();
      else if (key === 'Escape' && parts?.closeDetails()) event.preventDefault();
      else if (key === 'Escape' && !document.fullscreenElement) exit();
    }
    // Swipe: sideways advances (it means "the next thing", a step or a
    // slide); down from the top edge shows the controls.
    let swipe = null;
    // The click that ends a mouse drag must not also press what is under it.
    let suppressClick = false;
    function onPointerDown(event) {
      suppressClick = false;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      swipe = { x: event.clientX, y: event.clientY, top: event.clientY - el.getBoundingClientRect().top < 48, touch: event.pointerType !== 'mouse', interactive: !!event.target.closest?.('button,a,input,textarea,select,video,audio,canvas,[data-fmdp-no-swipe],[role=button],[role=radio],[role=checkbox],.fmdp-top,.fmdp-bottom') };
    }
    function onPointerUp(event) {
      const start = swipe;
      swipe = null;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (start.touch && start.top && dy > 36 && Math.abs(dy) > Math.abs(dx)) { revealControls(); return; }
      // A mouse drag has to be more deliberate than a finger.
      if (start.interactive || Math.abs(dx) < (start.touch ? 56 : 90) || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      suppressClick = !start.touch;
      if (dx < 0) next(); else back();
    }
    function fullscreen() {
      const target = opts.fullscreenEl || el;
      if (document.fullscreenElement) document.exitFullscreen?.();
      else target.requestFullscreen?.().catch(() => {});
    }
    function exit() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      try { opts.onExit?.(position()); } catch (e) { /* host callback */ }
    }
    el.addEventListener('click', onClick, true);
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    edge.addEventListener('pointerenter', () => revealControls());
    top.addEventListener('pointerenter', () => revealControls(true));
    top.addEventListener('pointerleave', () => revealControls());

    // ------------------------------------------------------------- render
    function renderDocument() {
      const renderOptions = {
        document: opts.document, theme: opts.theme, themeContext: opts.themeContext, widgetData: opts.widgetData,
        widgetContext: opts.widgetContext, widgetRegistry: opts.widgetRegistry, mediaUrl: opts.mediaUrl, orgId: opts.orgId,
        capabilities: opts.capabilities, mode: 'interactive', scale: 1
      };
      if (handle) handle.update(renderOptions); else handle = renderer.render(stage, renderOptions);
      const settle = () => {
        if (destroyed) return;
        pageIndex = clamp(pageIndex, 0, Math.max(0, pages().length - 1));
        stepIndex = clamp(stepIndex, 0, stepCount(pageIndex));
        fit();
        applyState(pageIndex, stepIndex);
        show(pageIndex);
        renderControls();
        actions = new Map();
        model.walkNodes(doc(), (node) => {
          const action = obj(obj(node.props).action);
          if (!action.type) return;
          actions.set(node.id, action);
          const target = nodeEl(stage, node.id);
          if (target) { target.setAttribute('data-part-action', String(action.type)); target.setAttribute('role', 'button'); target.tabIndex = 0; }
        });
        // Selections, prices and the review are assemblies wired to the live state.
        if (root.FMDocParts && opts.live) {
          if (parts) liveState = parts.state();
          parts?.destroy();
          parts = root.FMDocParts.attach(stage, {
            document: doc(), state: liveState, readonly: obj(opts.live).readonly === true, navigate,
            onInput: async (input) => {
              const result = await obj(opts.live).onInput?.(input, position());
              if (result && typeof result === 'object') liveState = result;
              return result;
            },
            onError: obj(opts.live).onError
          });
        }
      };
      settle();
      return Promise.resolve(handle.ready?.()).then(settle, settle);
    }
    let ready = renderDocument().then(() => {
      announce();
      const steps = pageSteps(pages()[pageIndex]);
      if (stepIndex === 0 && steps[0] && steps[0].auto) {
        if (reduced()) { stepIndex = rest(pageIndex, 0); applyState(pageIndex, stepIndex); announce(); }
        else autoTimer = setTimeout(playStep, 350);
      }
    });
    if (opts.autofocus !== false) setTimeout(() => { if (!destroyed) el.focus({ preventScroll: true }); }, 0);

    return {
      element: el,
      ready: () => ready,
      next, back, goTo, position, fullscreen,
      navigate,
      /** The live state as the slides currently show it. */
      state: () => (parts ? parts.state() : liveState),
      /** New live state from outside (no re-render), e.g. another device changed a choice. */
      setState(state) { liveState = obj(state); parts?.update({ state: liveState }); },
      /** Re-render with a new document or data without losing the place. */
      update(nextOptions) {
        opts = Object.assign({}, opts, nextOptions || {});
        if (obj(nextOptions).live && obj(nextOptions.live).state) { liveState = obj(nextOptions.live.state); parts?.update({ state: liveState }); parts?.destroy(); parts = null; }
        stop();
        ready = renderDocument();
        return ready;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        stop();
        clearTimeout(hideControls);
        parts?.destroy();
        resize?.disconnect();
        try { handle?.destroy(); } catch (e) { /* renderer already gone */ }
        el.remove();
      }
    };
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function CSS_ESCAPE(value) {
    return String(value ?? '').replace(/["\\]/g, '\\$&');
  }

  return { mount, pageSteps, pageTransition, stateAtStep, TRANSITIONS, EFFECTS, DIRECTIONS };
});
