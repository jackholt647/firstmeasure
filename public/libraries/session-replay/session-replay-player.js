/* libraries/session-replay/session-replay-player.js
 * Rebuilds a recorded session in a sandboxed, script-free iframe and plays it.
 * Needs session-replay-codec.js. See docs/architecture/session-replay.md.
 *
 *   const model = new FMReplayPlayer.SessionModel();
 *   model.addPage(pageId, startedAt); model.addChunk(pageId, seq, chunkObject);
 *   const player = FMReplayPlayer.create({ stage: element, model, blobs: Map });
 *   player.play();
 *
 * Nothing recorded runs: the iframe has no allow-scripts, stylesheets come from the
 * recording, and hover, focus and pressed states are reproduced by rewriting those
 * pseudo-classes to classes the player sets from the recorded pointer and focus.
 */
(function () {
  'use strict';
  const root = window;
  const Codec = root.FMReplayCodec;
  if (!Codec) throw new Error('session-replay-codec.js must load before the player.');
  const { E, PTR } = Codec;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATH_NS = 'http://www.w3.org/1998/Math/MathML';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const PSEUDO = /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g;
  const PRELOAD_REL = /(^|\s)(preload|prefetch|modulepreload|preconnect|dns-prefetch|prerender|manifest)(\s|$)/i;
  const IDLE_GAP_MS = 4000;
  // Idle means the person did nothing: pointer moves under this many pixels (a resting hand, a jittery mouse) and
  // changes the page makes by itself (polling, clocks, hover flicker) do not count as activity.
  const IDLE_POINTER_PX = 12;
  const ACTIVE_EVENTS = new Set([E.SNAPSHOT, E.PTR, E.SCROLL, E.VIEW, E.INPUT, E.FOCUS, E.KEY, E.NAV, E.VIS, E.END]);

  // ---------------------------------------------------------------------------
  // Decoded data
  // ---------------------------------------------------------------------------
  class PageTrack {
    constructor(pageId, startedAt) {
      this.pageId = pageId;
      this.startedAt = startedAt || 0;
      this.strings = [];
      this.templates = new Codec.Templates(false);
      this.events = [];
      this.cursor = [];
      this.nextSeq = 0;
      this.waiting = new Map();
      this.blobKeys = new Set();
      this.firstT = Infinity;
      this.lastT = -Infinity;
      this.meta = null;
      this.error = '';
      this.chunkSizes = [];
    }

    add(seq, chunk, sizes) {
      if (seq < this.nextSeq || this.waiting.has(seq)) return false;
      this.waiting.set(seq, { chunk, sizes });
      let added = false;
      while (this.waiting.has(this.nextSeq) && !this.error) {
        const entry = this.waiting.get(this.nextSeq);
        this.waiting.delete(this.nextSeq);
        this.nextSeq++;
        try { this.ingest(entry.chunk); } catch (error) { this.error = String(error && error.message || error); }
        if (entry.sizes) this.chunkSizes.push(entry.sizes);
        added = true;
      }
      return added;
    }

    ingest(chunk) {
      for (let i = 0; i < chunk.s.length; i++) {
        const value = chunk.s[i];
        this.strings.push(value);
        if (Codec.isBlobRef(value)) this.blobKeys.add(value.slice(Codec.BLOB_PREFIX.length));
      }
      let t = chunk.t;
      for (let i = 0; i < chunk.e.length; i++) {
        const raw = chunk.e[i];
        t += raw[0];
        const type = raw[1];
        const a = raw.slice(2);
        // Trees are decoded in stream order: templates are numbered as they arrive.
        if (type === E.SNAPSHOT) a[1] = Codec.decodeTree(a[1], this.templates);
        else if (type === E.MUT && a[1]) { const adds = a[1]; for (let k = 3; k < adds.length; k += 4) adds[k] = Codec.decodeTree(adds[k], this.templates); }
        else if (type === E.FRAME || type === E.SHADOW) a[2] = Codec.decodeTree(a[2], this.templates);
        else if (type === E.META && !this.meta) { try { this.meta = JSON.parse(this.strings[a[0]]); } catch (error) { this.meta = {}; } }
        this.events.push({ t, type, a });
        if (t < this.firstT) this.firstT = t;
        if (t > this.lastT) this.lastT = t;
      }
      const m = chunk.m || [];
      let mt = chunk.t, mx = 0, my = 0;
      for (let i = 0; i < m.length; i += 3) {
        mt += m[i]; mx += m[i + 1]; my += m[i + 2];
        this.cursor.push(mt, mx, my);
        if (mt > this.lastT) this.lastT = mt;
        if (mt < this.firstT) this.firstT = mt;
      }
    }

    text(id) {
      const value = this.strings[id];
      return value === undefined ? '' : value;
    }
  }

  class SessionModel {
    constructor() {
      this.pages = [];
      this.byId = new Map();
      this.version = 0;
    }
    addPage(pageId, startedAt) {
      let page = this.byId.get(pageId);
      if (!page) {
        page = new PageTrack(pageId, startedAt);
        this.byId.set(pageId, page);
        this.pages.push(page);
      }
      return page;
    }
    addChunk(pageId, seq, chunk, sizes) {
      const page = this.addPage(pageId, chunk.t);
      const added = page.add(seq, chunk, sizes);
      if (added) {
        this.pages.sort((a, b) => (isFinite(a.firstT) ? a.firstT : a.startedAt) - (isFinite(b.firstT) ? b.firstT : b.startedAt));
        this.version++;
      }
      return added;
    }
    get start() {
      let start = Infinity;
      for (const page of this.pages) if (page.firstT < start) start = page.firstT;
      return start;
    }
    get end() {
      let end = -Infinity;
      for (const page of this.pages) if (page.lastT > end) end = page.lastT;
      return end;
    }
    pageAt(t) {
      let found = null;
      for (const page of this.pages) {
        if (!page.events.length) continue;
        if (page.firstT <= t) found = page; else break;
      }
      return found || this.pages.find((page) => page.events.length) || null;
    }
    blobKeys() {
      const keys = new Set();
      for (const page of this.pages) for (const key of page.blobKeys) keys.add(key);
      return keys;
    }
    /** Every event of every page with absolute times, for timelines and lists. */
    allEvents() {
      const out = [];
      for (const page of this.pages) for (const event of page.events) out.push({ page, t: event.t, type: event.type, a: event.a });
      out.sort((a, b) => a.t - b.t);
      return out;
    }
    /** Gaps in which the person did nothing (see IDLE_POINTER_PX), for skipping idle time. */
    idleGaps() {
      const times = [];
      for (const page of this.pages) {
        for (const event of page.events) if (ACTIVE_EVENTS.has(event.type)) times.push(event.t);
        const cursor = page.cursor;
        let ax = NaN, ay = NaN;
        for (let i = 0; i < cursor.length; i += 3) {
          const x = cursor[i + 1], y = cursor[i + 2];
          if (!(Math.abs(x - ax) < IDLE_POINTER_PX && Math.abs(y - ay) < IDLE_POINTER_PX)) { times.push(cursor[i]); ax = x; ay = y; }
        }
      }
      times.sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > IDLE_GAP_MS) gaps.push([times[i - 1], times[i]]);
      return gaps;
    }
  }

  // ---------------------------------------------------------------------------
  // Mirror: the recorded DOM, rebuilt
  // ---------------------------------------------------------------------------
  class Mirror {
    constructor(iframe, blobs) {
      this.iframe = iframe;
      this.blobs = blobs;
      this.page = null;
      this.nodes = new Map();
      this.ids = new WeakMap();
      this.pseudo = new Map();
      this.state = { hover: [], focus: [], active: [] };
      this.pendingScroll = new Map();
      this.view = null;
      this.url = '';
      this.inputs = new WeakMap();
    }

    text(id) {
      const value = this.page ? this.page.text(id) : '';
      if (Codec.isBlobRef(value)) {
        const blob = this.blobs.get(value.slice(Codec.BLOB_PREFIX.length));
        return blob === undefined ? '' : blob;
      }
      return value;
    }

    bind(id, node) {
      this.nodes.set(id, node);
      this.ids.set(node, id);
    }

    forget(node) {
      const id = this.ids.get(node);
      if (id !== undefined && this.nodes.get(id) === node) this.nodes.delete(id);
      this.pseudo.delete(node);
      if (node.shadowRoot) this.forget(node.shadowRoot);
      if (node.localName === 'iframe' || node.localName === 'frame') {
        try { if (node.contentDocument) this.forget(node.contentDocument); } catch (error) { /* gone */ }
      }
      for (let child = node.firstChild; child; child = child.nextSibling) this.forget(child);
    }

    reset(page) {
      this.page = page;
      this.nodes = new Map();
      this.ids = new WeakMap();
      this.pseudo = new Map();
      this.state = { hover: [], focus: [], active: [] };
      this.pendingScroll = new Map();
      this.url = page && page.meta ? page.meta.url || '' : '';
      this.view = page && page.meta && page.meta.viewport ? [page.meta.viewport.width, page.meta.viewport.height, Math.round((page.meta.device_pixel_ratio || 1) * 100), 1000, 0, 0] : null;
      const doc = this.iframe.contentDocument;
      if (doc) {
        try { doc.open(); doc.write('<!DOCTYPE html><html><head></head><body></body></html>'); doc.close(); } catch (error) { /* keep the blank document */ }
      }
    }

    namespaceFor(parent) {
      if (!parent || parent.nodeType !== 1) return null;
      if (parent.namespaceURI === SVG_NS && parent.localName !== 'foreignObject') return SVG_NS;
      if (parent.namespaceURI === MATH_NS) return MATH_NS;
      return null;
    }

    build(node, doc, ns, ref, frames, later) {
      if (typeof node === 'number') {
        const textNode = doc.createTextNode(this.text(node));
        this.bind(ref.v++, textNode);
        return textNode;
      }
      const tag = this.text(node[0]);
      const attrs = node[1] || null;
      let elementNs = ns;
      if (tag === 'svg') elementNs = SVG_NS;
      else if (tag === 'math') elementNs = MATH_NS;
      const asStyle = tag === 'link' && attrs && this.hasCss(attrs);
      let el;
      try { el = elementNs ? doc.createElementNS(elementNs, tag) : doc.createElement(asStyle ? 'style' : tag); }
      catch (error) { el = doc.createElement('span'); el.setAttribute('data-fmr-tag', tag); }
      this.bind(ref.v++, el);
      if (asStyle) el.setAttribute('data-fmr-link', '');
      if (attrs) {
        for (let i = 0; i < attrs.length; i += 2) {
          const name = this.text(attrs[i]);
          const value = this.text(attrs[i + 1]);
          if (name === '__value' || name === '__checked') later.push([el, name, value]);
          else this.setAttr(el, name, value, asStyle ? 'link' : tag);
        }
      }
      if (tag === 'link' && !asStyle && PRELOAD_REL.test(el.getAttribute('rel') || '') && el.hasAttribute('href')) {
        el.setAttribute('data-fmr-href', el.getAttribute('href'));
        el.removeAttribute('href');
      }
      const childNs = elementNs === SVG_NS && tag === 'foreignObject' ? null : elementNs;
      for (let i = 2; i < node.length; i++) {
        const child = node[i];
        if (typeof child === 'number' || Array.isArray(child)) {
          el.appendChild(this.build(child, doc, childNs, ref, frames, later));
        } else if (child.r) {
          const shadowId = ref.v++;
          let shadow = null;
          try { shadow = el.shadowRoot || el.attachShadow({ mode: 'open' }); } catch (error) { shadow = null; }
          if (shadow) this.bind(shadowId, shadow);
          for (let k = 0; k < child.r.length; k++) {
            const built = this.build(child.r[k], doc, null, ref, frames, later);
            if (shadow) shadow.appendChild(built);
          }
        } else if (child.d) {
          frames.push({ el, node: child, base: ref.v });
          ref.v += child.$n;
        }
      }
      return el;
    }

    hasCss(attrs) {
      for (let i = 0; i < attrs.length; i += 2) if (this.text(attrs[i]) === '__css') return true;
      return false;
    }

    finish(frames, later) {
      for (let i = 0; i < later.length; i++) this.applyValue(later[i][0], later[i][1], later[i][2]);
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        let doc = null;
        try { doc = frame.el.contentDocument; } catch (error) { doc = null; }
        if (doc) this.writeDocument(doc, frame.node, frame.base);
      }
    }

    applyValue(el, name, value) {
      try {
        if (name === '__checked') el.checked = value === '1';
        else el.value = value;
        this.inputs.set(el, name === '__checked' ? value : String(el.value));
      } catch (error) { /* not a form field */ }
    }

    writeDocument(doc, node, base) {
      const doctype = node.t >= 0 ? this.text(node.t) : '';
      try { doc.open(); doc.write((doctype || '') + '<html><head></head><body></body></html>'); doc.close(); } catch (error) { /* keep it */ }
      for (const child of Array.from(doc.childNodes)) if (child.nodeType !== 10) doc.removeChild(child);
      const ref = { v: base };
      this.bind(ref.v++, doc);
      const frames = [], later = [];
      for (let i = 0; i < node.d.length; i++) doc.appendChild(this.build(node.d[i], doc, null, ref, frames, later));
      const url = node.u >= 0 ? this.text(node.u) : '';
      const head = doc.head || doc.querySelector('head');
      if (head) {
        // The browser's own focus ring comes from its built-in :focus-visible rule,
        // which the recording cannot rewrite. Zero specificity lets page rules win.
        const ua = doc.createElement('style');
        ua.setAttribute('data-fmr-ignore', '');
        ua.textContent = ':where(.__fmr-focus-visible){outline:auto 1px -webkit-focus-ring-color}';
        head.insertBefore(ua, head.firstChild);
      }
      if (head && url && !/^about:/.test(url)) {
        const baseEl = doc.createElement('base');
        baseEl.setAttribute('href', url);
        head.insertBefore(baseEl, head.firstChild);
      }
      this.finish(frames, later);
    }

    setCss(el, css) {
      const rewritten = css.replace(PSEUDO, '.__fmr-$1');
      if (el.localName === 'style') { el.textContent = rewritten; return el; }
      // A <link> whose stylesheet arrived after it was written becomes a <style>.
      const doc = el.ownerDocument;
      const style = doc.createElement('style');
      style.setAttribute('data-fmr-link', '');
      for (const attr of Array.from(el.attributes)) this.setAttr(style, attr.name, attr.value, 'link');
      style.textContent = rewritten;
      const id = this.ids.get(el);
      if (el.parentNode) el.parentNode.replaceChild(style, el);
      if (id !== undefined) this.bind(id, style);
      return style;
    }

    setAttr(el, name, value, tag) {
      switch (name) {
        case '__css': this.setCss(el, value); return;
        case '__value': case '__checked': this.applyValue(el, name, value); return;
        default: break;
      }
      let target = name;
      if ((tag === 'iframe' || tag === 'frame') && (name === 'src' || name === 'srcdoc')) target = 'data-fmr-' + name;
      else if (name === 'autofocus' || name === 'autoplay') target = 'data-fmr-' + name;
      else if (tag === 'meta' && name === 'http-equiv') target = 'data-fmr-http-equiv';
      else if (tag === 'base' && name === 'href') target = 'data-fmr-href';
      else if (tag === 'link' && el.localName === 'style' && name !== 'media' && name !== 'class' && name !== 'id') target = 'data-fmr-' + name;
      else if ((tag === 'object' || tag === 'embed') && (name === 'data' || name === 'src')) target = 'data-fmr-' + name;
      try {
        if (target.startsWith('xlink:')) el.setAttributeNS(XLINK_NS, target, value);
        else if (target.startsWith('xml:')) el.setAttributeNS(XML_NS, target, value);
        else el.setAttribute(target, value);
      } catch (error) { /* invalid name */ }
      if (name === 'class') this.restorePseudo(el);
    }

    removeAttr(el, name, tag) {
      if (name === '__css') { if (el.localName === 'style') el.textContent = ''; return; }
      if (name.startsWith('__')) return;
      let target = name;
      if ((tag === 'iframe' || tag === 'frame') && (name === 'src' || name === 'srcdoc')) target = 'data-fmr-' + name;
      else if (tag === 'link' && el.localName === 'style' && name !== 'media' && name !== 'class' && name !== 'id') target = 'data-fmr-' + name;
      try { el.removeAttribute(target); } catch (error) { /* ignore */ }
      if (name === 'class') this.restorePseudo(el);
    }

    tagOf(el) {
      return el.localName === 'style' && el.hasAttribute('data-fmr-link') ? 'link' : el.localName;
    }

    // --- pseudo-class states ---------------------------------------------------
    addPseudo(el, cls) {
      let set = this.pseudo.get(el);
      if (!set) this.pseudo.set(el, set = new Set());
      set.add(cls);
      try { el.classList.add(cls); } catch (error) { /* no classList */ }
    }
    removePseudo(el, cls) {
      const set = this.pseudo.get(el);
      if (set) { set.delete(cls); if (!set.size) this.pseudo.delete(el); }
      try { el.classList.remove(cls); } catch (error) { /* ignore */ }
    }
    restorePseudo(el) {
      const set = this.pseudo.get(el);
      if (set) for (const cls of set) { try { el.classList.add(cls); } catch (error) { /* ignore */ } }
    }
    chain(node) {
      const out = [];
      let n = node;
      for (let guard = 0; n && guard < 400; guard++) {
        if (n.nodeType === 1) out.push(n);
        n = n.parentNode || n.host || (n.nodeType === 9 && n.defaultView ? n.defaultView.frameElement : null);
      }
      return out;
    }
    setChainState(kind, id) {
      const cls = '__fmr-' + kind;
      for (const el of this.state[kind]) this.removePseudo(el, cls);
      const node = id ? this.nodes.get(id) : null;
      const chain = node ? this.chain(node) : [];
      for (const el of chain) this.addPseudo(el, cls);
      this.state[kind] = chain;
    }
    setFocus(id, visible) {
      for (const el of this.state.focus) {
        this.removePseudo(el, '__fmr-focus-within');
        this.removePseudo(el, '__fmr-focus');
        this.removePseudo(el, '__fmr-focus-visible');
      }
      const node = id ? this.nodes.get(id) : null;
      const chain = node ? this.chain(node) : [];
      chain.forEach((el, index) => {
        this.addPseudo(el, '__fmr-focus-within');
        if (index === 0) {
          this.addPseudo(el, '__fmr-focus');
          if (visible) this.addPseudo(el, '__fmr-focus-visible');
        }
      });
      this.state.focus = chain;
    }

    // --- events -------------------------------------------------------------------
    apply(event, fast) {
      const a = event.a;
      switch (event.type) {
        case E.SNAPSHOT: {
          const doc = this.iframe.contentDocument;
          if (doc) this.writeDocument(doc, a[1], a[0]);
          // A rewritten document keeps the old scroll offset; the recording starts at the top
          // unless a scroll event follows.
          if (fast) this.pendingScroll.set(a[0], [0, 0]); else this.scrollTo(a[0], 0, 0);
          break;
        }
        case E.MUT: this.mutate(a); break;
        case E.FRAME: {
          const frame = this.nodes.get(a[0]);
          if (!frame) break;
          let doc = null;
          try { doc = frame.contentDocument; } catch (error) { doc = null; }
          if (!doc) break;
          this.forget(doc);
          this.writeDocument(doc, a[2], a[1]);
          if (fast) this.pendingScroll.set(a[1], [0, 0]); else this.scrollTo(a[1], 0, 0);
          break;
        }
        case E.SHADOW: {
          const host = this.nodes.get(a[0]);
          if (!host) break;
          let shadow = null;
          try { shadow = host.shadowRoot || host.attachShadow({ mode: 'open' }); } catch (error) { shadow = null; }
          if (!shadow) break;
          while (shadow.firstChild) { this.forget(shadow.firstChild); shadow.removeChild(shadow.firstChild); }
          const ref = { v: a[1] };
          this.bind(ref.v++, shadow);
          const frames = [], later = [];
          for (const child of a[2].r) shadow.appendChild(this.build(child, host.ownerDocument, null, ref, frames, later));
          this.finish(frames, later);
          break;
        }
        case E.INPUT: {
          const el = this.nodes.get(a[0]);
          if (!el) break;
          try {
            if (a[1] === 1) el.checked = !!a[2];
            else if (a[1] === 2) { const before = String(el.value); el.value = before.slice(0, a[2]) + this.text(a[4]) + before.slice(a[2] + a[3]); }
            else el.value = this.text(a[2]);
          } catch (error) { /* not a field */ }
          break;
        }
        case E.SCROLL:
          if (fast) this.pendingScroll.set(a[0], [a[1], a[2]]);
          else this.scrollTo(a[0], a[1], a[2]);
          break;
        case E.VIEW: this.view = a.slice(0, 6); break;
        case E.HOVER: this.setChainState('hover', a[0]); break;
        case E.FOCUS: this.setFocus(a[0], a[1]); break;
        case E.PTR:
          if (a[0] === PTR.DOWN) this.setChainState('active', a[1]);
          else if (a[0] === PTR.UP) this.setChainState('active', 0);
          break;
        case E.NAV: this.url = this.text(a[0]); break;
        default: break;
      }
    }

    mutate(a) {
      const removes = a[0], adds = a[1], attrs = a[2], texts = a[3];
      if (removes) {
        for (let i = 0; i < removes.length; i++) {
          const node = this.nodes.get(removes[i]);
          if (!node) continue;
          this.forget(node);
          if (node.parentNode) node.parentNode.removeChild(node);
        }
      }
      if (adds) {
        for (let i = 0; i < adds.length; i += 4) {
          const parent = this.nodes.get(adds[i]);
          if (!parent) continue;
          const next = adds[i + 1] ? this.nodes.get(adds[i + 1]) : null;
          const doc = parent.nodeType === 9 ? parent : parent.ownerDocument;
          const frames = [], later = [];
          const built = this.build(adds[i + 3], doc, this.namespaceFor(parent), { v: adds[i + 2] }, frames, later);
          try { parent.insertBefore(built, next && next.parentNode === parent ? next : null); } catch (error) { continue; }
          this.finish(frames, later);
        }
      }
      if (attrs) {
        for (let i = 0; i < attrs.length; i += 3) {
          const el = this.nodes.get(attrs[i]);
          if (!el || el.nodeType !== 1) continue;
          const name = this.text(attrs[i + 1]);
          if (attrs[i + 2] === -1) this.removeAttr(el, name, this.tagOf(el));
          else this.setAttr(el, name, this.text(attrs[i + 2]), this.tagOf(el));
        }
      }
      if (texts) {
        for (let i = 0; i < texts.length; i += 2) {
          const node = this.nodes.get(texts[i]);
          if (node && node.nodeType === 3) node.data = this.text(texts[i + 1]);
        }
      }
    }

    scrollTo(id, x, y) {
      const node = this.nodes.get(id);
      if (!node) return;
      try {
        if (node.nodeType === 9) { if (node.defaultView) node.defaultView.scrollTo(x, y); }
        else { node.scrollLeft = x; node.scrollTop = y; }
      } catch (error) { /* detached */ }
    }

    flushScroll() {
      for (const [id, position] of this.pendingScroll) this.scrollTo(id, position[0], position[1]);
      this.pendingScroll.clear();
    }

    describe(id) {
      const node = this.nodes.get(id);
      if (!node || node.nodeType !== 1) return '';
      const text = (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return node.localName + (node.id ? '#' + node.id : '') + (text ? ' "' + text + '"' : '');
    }
  }

  // ---------------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------------
  const CURSOR_SVG = '<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.8 L18.5 15.8 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function create(options) {
    const stage = options.stage;
    const blobs = options.blobs || new Map();
    let model = options.model || new SessionModel();
    stage.innerHTML = '';
    stage.classList.add('fmr-stage');
    const frameBox = document.createElement('div');
    frameBox.className = 'fmr-frame';
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('title', 'Session replay');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#fff;pointer-events:none';
    const overlay = document.createElement('div');
    overlay.className = 'fmr-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    const trail = document.createElementNS(SVG_NS, 'svg');
    trail.setAttribute('class', 'fmr-trail');
    trail.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible';
    const trailPath = document.createElementNS(SVG_NS, 'path');
    trailPath.setAttribute('fill', 'none');
    trailPath.setAttribute('stroke', 'rgba(239,68,68,.55)');
    trailPath.setAttribute('stroke-width', '3');
    trailPath.setAttribute('stroke-linecap', 'round');
    trailPath.setAttribute('stroke-linejoin', 'round');
    trail.appendChild(trailPath);
    const cursor = document.createElement('div');
    cursor.className = 'fmr-cursor';
    cursor.innerHTML = CURSOR_SVG;
    cursor.style.cssText = 'position:absolute;left:0;top:0;width:22px;height:28px;margin:-2px 0 0 -2px;display:none;will-change:transform';
    overlay.appendChild(trail);
    overlay.appendChild(cursor);
    frameBox.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.35)';
    frameBox.appendChild(iframe);
    frameBox.appendChild(overlay);
    stage.appendChild(frameBox);

    const mirror = new Mirror(iframe, blobs);
    const listeners = new Set();
    const state = {
      t: 0, playing: false, speed: 1, skipIdle: true, follow: false, page: null, index: 0, applied: -Infinity,
      lastWall: 0, raf: 0, gaps: [], gapsVersion: -1, ripples: [], showTrail: true, size: [0, 0], scale: 1, skipping: false
    };

    function emit(kind) { for (const fn of listeners) { try { fn(kind, api); } catch (error) { console.warn(error); } } }

    function layout() {
      const view = mirror.view || [1280, 800];
      const width = Math.max(1, view[0]), height = Math.max(1, view[1]);
      const availW = stage.clientWidth - 24, availH = stage.clientHeight - 24;
      const scale = Math.max(0.05, Math.min(availW / width, availH / height, 2));
      if (state.size[0] !== width || state.size[1] !== height) {
        frameBox.style.width = width + 'px';
        frameBox.style.height = height + 'px';
        state.size = [width, height];
      }
      state.scale = scale;
      frameBox.style.transform = 'translate(' + Math.round((stage.clientWidth - width * scale) / 2) + 'px,' + Math.round((stage.clientHeight - height * scale) / 2) + 'px) scale(' + scale + ')';
    }

    function loadPage(page) {
      state.page = page;
      state.index = 0;
      state.applied = -Infinity;
      mirror.reset(page);
      state.ripples = [];
    }

    function applyTo(t, fast) {
      const page = model.pageAt(t);
      if (!page) return;
      if (page !== state.page || t < state.applied) { loadPage(page); fast = true; }
      const events = page.events;
      while (state.index < events.length && events[state.index].t <= t) {
        const event = events[state.index++];
        try { mirror.apply(event, fast); } catch (error) { console.warn('[session replay] could not apply event', event.type, error); }
        if (!fast && event.type === E.PTR && (event.a[0] === PTR.DOWN || event.a[0] === PTR.CLICK) && event.a[2] >= 0) {
          state.ripples.push({ t: event.t, x: event.a[2], y: event.a[3], kind: event.a[0] });
        }
      }
      if (fast) mirror.flushScroll();
      state.applied = t;
      layout();
    }

    function renderCursor(t) {
      const page = state.page;
      const track = page ? page.cursor : null;
      if (!track || !track.length || t < track[0]) { cursor.style.display = 'none'; trailPath.setAttribute('d', ''); }
      else {
        const position = Codec.pathPosition(track, t);
        cursor.style.display = 'block';
        cursor.style.transform = 'translate(' + position[0] + 'px,' + position[1] + 'px)';
        if (state.showTrail) {
          let d = '';
          for (let k = 12; k >= 0; k--) {
            const p = Codec.pathPosition(track, Math.max(track[0], t - k * 40));
            d += (d ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
          }
          trailPath.setAttribute('d', d);
        }
      }
      const live = [];
      for (const ripple of state.ripples) {
        const age = t - ripple.t;
        if (age < 0 || age > 700) { if (ripple.el) ripple.el.remove(); continue; }
        if (!ripple.el) {
          ripple.el = document.createElement('div');
          ripple.el.style.cssText = 'position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid rgba(239,68,68,.9);pointer-events:none';
          overlay.appendChild(ripple.el);
        }
        const p = age / 700;
        ripple.el.style.transform = 'translate(' + ripple.x + 'px,' + ripple.y + 'px) scale(' + (0.4 + p * 1.1) + ')';
        ripple.el.style.opacity = String(1 - p);
        live.push(ripple);
      }
      state.ripples = live;
    }

    function idleGapAt(t) {
      if (state.gapsVersion !== model.version) { state.gaps = model.idleGaps(); state.gapsVersion = model.version; }
      for (const gap of state.gaps) if (t > gap[0] + 800 && t < gap[1] - 800) return gap;
      return null;
    }

    function frame(wall) {
      state.raf = 0;
      if (!state.playing) return;
      const elapsed = state.lastWall ? Math.min(250, wall - state.lastWall) : 0;
      state.lastWall = wall;
      let t = state.t + elapsed * state.speed;
      state.skipping = false;
      if (state.skipIdle) {
        const gap = idleGapAt(t);
        if (gap) { t = gap[1] - 800; state.skipping = true; }
      }
      const end = model.end;
      if (t >= end) {
        t = end;
        if (!state.follow) state.playing = false;
      }
      state.t = t;
      applyTo(t, false);
      renderCursor(t);
      emit('time');
      if (state.playing) state.raf = requestAnimationFrame(frame);
      else emit('state');
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
    if (resizeObserver) resizeObserver.observe(stage);

    const api = {
      mirror,
      get model() { return model; },
      set model(next) { model = next; state.page = null; state.applied = -Infinity; },
      get time() { return state.t; },
      get playing() { return state.playing; },
      get speed() { return state.speed; },
      set speed(value) { state.speed = Math.max(0.25, Math.min(32, Number(value) || 1)); emit('state'); },
      get skipIdle() { return state.skipIdle; },
      set skipIdle(value) { state.skipIdle = !!value; emit('state'); },
      get follow() { return state.follow; },
      set follow(value) { state.follow = !!value; emit('state'); },
      get skipping() { return state.skipping; },
      get page() { return state.page; },
      get scale() { return state.scale; },
      get showTrail() { return state.showTrail; },
      set showTrail(value) { state.showTrail = !!value; renderCursor(state.t); },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      play() {
        if (state.playing) return;
        if (state.t >= model.end && !state.follow) state.t = model.start;
        state.playing = true;
        state.lastWall = 0;
        state.raf = requestAnimationFrame(frame);
        emit('state');
      },
      pause() {
        state.playing = false;
        if (state.raf) cancelAnimationFrame(state.raf);
        state.raf = 0;
        emit('state');
      },
      seek(t) {
        const start = model.start, end = model.end;
        if (!isFinite(start)) return;
        state.t = Math.max(start, Math.min(end, t));
        applyTo(state.t, true);
        state.ripples.forEach((ripple) => ripple.el && ripple.el.remove());
        state.ripples = [];
        renderCursor(state.t);
        emit('time');
      },
      /** Rebuild the current moment (after stylesheets arrive). */
      rebuild() {
        state.page = null;
        api.seek(state.t || model.start);
      },
      /** New data arrived: show it if it is behind the playhead. */
      refresh() {
        if (!state.page && isFinite(model.start)) { api.seek(model.start); return; }
        if (!state.playing) { applyTo(state.t, true); renderCursor(state.t); }
        emit('data');
      },
      describe: (id) => mirror.describe(id),
      destroy() {
        api.pause();
        if (resizeObserver) resizeObserver.disconnect();
        stage.innerHTML = '';
      }
    };
    return api;
  }

  root.FMReplayPlayer = { create, SessionModel, PageTrack, Mirror };
})();
