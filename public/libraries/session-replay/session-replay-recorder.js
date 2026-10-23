/* libraries/session-replay/session-replay-recorder.js
 * Records a page as a DOM snapshot followed by deltas, so it can be replayed later
 * without video and without knowing which release of the page was running.
 * Needs session-replay-codec.js. Knows nothing about FirstMate: the caller passes a
 * transport (see session-replay-loader.js). See docs/architecture/session-replay.md.
 *
 *   const recorder = FMReplayRecorder.create({ transport, sessionId, pageId });
 *   recorder.start();
 *
 * What is recorded: the DOM (MutationObserver deltas, nothing is diffed by hand),
 * same-origin iframes and open or closed shadow roots, stylesheet text, form values
 * (passwords and card fields masked), scrolling, viewport, pointer path, clicks,
 * keys (printable characters are recorded only as "char"), focus, hover, URL
 * changes, script errors and the recorder's own cost. Nothing is ever sent to any
 * place except the transport.
 */
(function () {
  'use strict';
  const root = window;
  if (root.FMReplayRecorder) return;
  const Codec = root.FMReplayCodec;
  if (!Codec) {
    console.warn('[session replay] session-replay-codec.js must load first.');
    return;
  }
  const { E, PTR } = Codec;
  const VERSION = '2026.10.23.1';
  const perf = root.performance;
  const timeOrigin = Math.round(perf.timeOrigin || (Date.now() - perf.now()));
  const clock = () => Math.round(perf.now());
  const MO_OPTIONS = { childList: true, subtree: true, attributes: true, characterData: true };
  const LISTEN = { capture: true, passive: true };
  const IGNORED_TAGS = new Set(['script', 'noscript']);
  const POINTER_TYPES = { mouse: 0, touch: 1, pen: 2 };
  const ZERO = [0, 0];
  const MAX_QUEUE = 120;
  const MAX_STRING_CHARS = 16 * 1024 * 1024;

  // One recorder at a time per window; prototype hooks dispatch to it.
  let active = null;
  const patchedWindows = new WeakSet();

  function hookSetter(proto, prop, note) {
    const desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set || !desc.configurable) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(value) {
        desc.set.call(this, value);
        if (active) { try { note(this); } catch (error) { /* never break the page */ } }
      }
    });
  }

  function wrapMethod(target, name, after) {
    const original = target && target[name];
    if (typeof original !== 'function' || original.__fmrWrapped) return;
    const wrapped = function () {
      const result = original.apply(this, arguments);
      if (active) { try { after(this, result, arguments); } catch (error) { /* never break the page */ } }
      return result;
    };
    wrapped.__fmrWrapped = true;
    try { target[name] = wrapped; } catch (error) { /* read-only */ }
  }

  function patchWindow(win) {
    if (!win || patchedWindows.has(win)) return;
    patchedWindows.add(win);
    const noteInput = (el) => active.noteInput(el);
    try {
      hookSetter(win.HTMLInputElement.prototype, 'value', noteInput);
      hookSetter(win.HTMLInputElement.prototype, 'checked', noteInput);
      hookSetter(win.HTMLTextAreaElement.prototype, 'value', noteInput);
      hookSetter(win.HTMLSelectElement.prototype, 'value', noteInput);
      hookSetter(win.HTMLSelectElement.prototype, 'selectedIndex', noteInput);
      hookSetter(win.HTMLOptionElement.prototype, 'selected', (option) => { const select = option.closest && option.closest('select'); if (select) active.noteInput(select); });
    } catch (error) { /* older engines */ }
    try { wrapMethod(win.Element.prototype, 'attachShadow', (host, shadow) => active.noteShadow(host, shadow)); } catch (error) { /* none */ }
    try {
      const sheetProto = win.CSSStyleSheet && win.CSSStyleSheet.prototype;
      ['insertRule', 'deleteRule', 'addRule', 'removeRule', 'replaceSync'].forEach((name) => wrapMethod(sheetProto, name, (sheet) => active.noteSheet(sheet)));
    } catch (error) { /* none */ }
    try {
      ['pushState', 'replaceState'].forEach((name) => wrapMethod(win.history, name, () => active.noteUrl()));
    } catch (error) { /* none */ }
    win.addEventListener('error', (event) => { if (active) active.noteError(event); }, true);
    win.addEventListener('unhandledrejection', (event) => { if (active) active.noteRejection(event); });
  }

  function randomId(length) {
    const bytes = new Uint8Array(length);
    (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
    let out = '';
    for (let i = 0; i < length; i++) out += 'abcdefghijklmnopqrstuvwxyz0123456789'[bytes[i] % 36];
    return out;
  }

  async function gzip(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof CompressionStream === 'undefined') return { bytes, raw: bytes.length, compressed: false };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return { bytes: out, raw: bytes.length, compressed: true };
  }

  function clampInterval(value, fallback) {
    const ms = Number(value);
    return Math.min(60000, Math.max(1000, ms > 0 ? ms : fallback));
  }

  // For transports that must send text; the FirstMate transport sends the gzip bytes as they are.
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function doctypeText(doctype) {
    let out = '<!DOCTYPE ' + (doctype.name || 'html');
    if (doctype.publicId) out += ' PUBLIC "' + doctype.publicId + '"';
    if (doctype.systemId) out += (doctype.publicId ? '' : ' SYSTEM') + ' "' + doctype.systemId + '"';
    return out + '>';
  }

  function absoluteUrls(css, base) {
    return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (match, quote, url) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return match;
      try { return 'url("' + new URL(url, base).href + '")'; } catch (error) { return match; }
    });
  }

  function sheetText(sheet, base) {
    let rules;
    try { rules = sheet.cssRules; } catch (error) { return null; }
    if (!rules) return null;
    let out = '';
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.type === 3 && rule.styleSheet) {
        const nested = sheetText(rule.styleSheet, rule.styleSheet.href || base);
        if (nested !== null) { out += nested; continue; }
      }
      out += rule.cssText + '\n';
    }
    return base ? absoluteUrls(out, base) : out;
  }

  const isStylesheetLink = (el) => /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') || '');
  const isHandlerAttribute = (name) => name.length > 2 && name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110 && /^on[a-z]+$/.test(name);
  const docOf = (node) => (node && (node.nodeType === 9 ? node : node.ownerDocument)) || null;
  const deepTarget = (event) => (event.composedPath ? event.composedPath()[0] : event.target) || event.target;

  function create(options = {}) {
    const transport = options.transport;
    if (!transport) throw new Error('FMReplayRecorder.create needs a transport.');
    const topWin = options.window || root;
    const topDoc = topWin.document;
    // Chunks go out every chunkIntervalMs (the first after a second). A transport's reply may name another
    // interval (`next_ms`): shorter while someone follows this session live, back to normal when they stop.
    const steadyMs = clampInterval(options.chunkIntervalMs, 20000);
    let intervalMs = steadyMs;
    const maskAll = options.maskAllInputs === true;
    const state = {
      sessionId: options.sessionId || randomId(20),
      pageId: options.pageId || randomId(10),
      pageStartedAt: Date.now(),
      recording: false,
      stopReason: ''
    };

    // Per-page encoding state (reset by restartPage).
    let ids, nextId, strings, stringCount, stringChars, pendingStrings, templates, encodeStats;
    let events, lastPushT, seq, lastInput, lastCss, lastScroll, maskedInputs;
    const editedSheets = new WeakSet();
    const closedShadows = new WeakMap();
    const pendingBlobs = new Map();
    const knownBlobs = new Set(options.knownBlobs || []);

    // Pending work, flushed in batches.
    let mo = null;
    let moPending = [];
    let moFirstT = 0;
    let moTimer = 0;
    const dirtyInputs = new Set();
    const dirtyStyles = new Set();
    const newShadows = [];
    const frameLoads = new Set();
    const pendingScroll = new Map();
    let scrollTimer = 0;
    let viewTimer = 0;
    let focusQueued = false;
    let mouse = [];
    let lastPoint = null;
    let hoverId = 0;
    let focusId = 0;
    let lastView = '';
    let lastUrl = '';
    let errorCount = 0;
    // Pages reached since the last chunk, as [path and hash, time]; the query string is left out (it can carry tokens).
    let pathsPending = [];
    let lastPath = '';
    let pausing = false;
    let blobPromise = null;
    let blobTimer = 0;
    const utf8 = new TextEncoder();

    // Uploads.
    const queue = [];
    let pumping = false;
    let retryTimer = 0;
    let backoff = 0;
    let chunkTimer = 0;
    let diagTimer = 0;
    let firstChunkTimer = 0;

    // Diagnostics.
    const diag = {
      cpu_ms: 0, snapshot_ms: 0, snapshot_nodes: 0, flushes: 0, flush_ms: 0, flush_max_ms: 0,
      mutations: 0, events: 0, raw_bytes: 0, gzip_bytes: 0, chunks: 0, failures: 0, upload_ms: 0, last_upload_ms: 0,
      blob_raw_bytes: 0, blob_gzip_bytes: 0, blobs: 0, long_tasks: 0, long_task_ms: 0, lag_ms: 0, internal_errors: 0,
      started_at: clock(), pages: 0
    };
    const samples = [];
    let sampleCursor = { cpu: 0, t: clock(), long: 0, longMs: 0, mutations: 0, events: 0, lag: 0 };
    let streamCursor = { cpu: 0, t: clock(), long: 0, longMs: 0, mutations: 0, events: 0, lag: 0 };
    let depth = 0;
    let longTaskObserver = null;

    function timed(fn) {
      return function (arg) {
        if (!state.recording) return undefined;
        const start = perf.now();
        depth++;
        try { return fn(arg); }
        catch (error) { diag.internal_errors++; if (diag.internal_errors < 5) console.warn('[session replay]', error); return undefined; }
        finally { depth--; if (!depth) diag.cpu_ms += perf.now() - start; }
      };
    }

    function resetPageState() {
      ids = new WeakMap(); nextId = 1;
      strings = new Map(); stringCount = 0; stringChars = 0; pendingStrings = [];
      templates = new Codec.Templates(true); encodeStats = Codec.newEncodeStats();
      events = []; lastPushT = 0; seq = 0;
      lastInput = new WeakMap(); lastCss = new WeakMap(); lastScroll = new WeakMap();
      maskedInputs = new WeakSet();
      moPending = []; moFirstT = 0;
      dirtyInputs.clear(); dirtyStyles.clear(); newShadows.length = 0; frameLoads.clear(); pendingScroll.clear();
      mouse = []; hoverId = 0; focusId = -1; lastView = ''; lastUrl = '';
      pathsPending = []; lastPath = '';
    }

    function pagePath() {
      const location = topWin.location;
      return ((location.pathname || '/') + (location.hash || '')).slice(0, 500);
    }

    // Pages an administrator set not to record (options.pageAllowed, from the loader's config).
    function allowedHere() {
      if (!options.pageAllowed) return true;
      try { return options.pageAllowed(pagePath()) !== false; } catch (error) { return true; }
    }

    function notePath() {
      const path = pagePath();
      if (path === lastPath) return;
      lastPath = path;
      pathsPending.push([path, timeOrigin + clock()]);
    }

    function push(event) {
      if (pendingScroll.size && event[1] !== E.SCROLL) flushScroll();
      if (event[0] < lastPushT) event[0] = lastPushT;
      lastPushT = event[0];
      events.push(event);
      diag.events++;
    }

    // -------------------------------------------------------------------------
    // Strings
    // -------------------------------------------------------------------------
    function intern(value) {
      const text = typeof value === 'string' ? value : String(value == null ? '' : value);
      if (text.length >= Codec.BLOB_MIN_CHARS) {
        const key = Codec.blobKey(text);
        const marker = Codec.BLOB_PREFIX + key;
        let id = strings.get(marker);
        if (id === undefined) {
          id = stringCount++;
          strings.set(marker, id);
          pendingStrings.push(marker);
          stringChars += marker.length;
          if (!knownBlobs.has(key)) { pendingBlobs.set(key, text); scheduleBlobs(); }
        }
        return id;
      }
      let id = strings.get(text);
      if (id === undefined) {
        id = stringCount++;
        strings.set(text, id);
        pendingStrings.push(text);
        stringChars += text.length;
      }
      return id;
    }

    // -------------------------------------------------------------------------
    // Masking
    // -------------------------------------------------------------------------
    function isMasked(el) {
      if (maskedInputs.has(el)) return true;
      let masked = maskAll;
      if (!masked) {
        const type = (el.getAttribute('type') || '').toLowerCase();
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
        masked = type === 'password' || autocomplete.startsWith('cc-') || autocomplete.includes('password')
          || autocomplete === 'one-time-code' || el.hasAttribute('data-fmr-mask');
      }
      if (masked) maskedInputs.add(el);
      return masked;
    }
    const mask = (value) => '*'.repeat(Math.min(String(value).length, 256));

    // -------------------------------------------------------------------------
    // Serialization (pre-order ids; see the codec for the node format)
    // -------------------------------------------------------------------------
    function serNode(node) {
      const type = node.nodeType;
      if (type === 3) { ids.set(node, nextId++); return intern(node.data); }
      if (type === 1) return serElement(node);
      return null;
    }

    function serElement(el) {
      const tag = el.localName;
      if (IGNORED_TAGS.has(tag) || el.hasAttribute('data-fmr-ignore')) return null;
      ids.set(el, nextId++);
      const node = [intern(tag), serAttributes(el, tag)];
      const shadow = el.shadowRoot || closedShadows.get(el);
      if (shadow) node.push(serShadow(shadow));
      if (tag === 'iframe' || tag === 'frame') {
        watchFrame(el);
        const doc = frameDocument(el);
        if (doc) node.push(serDocument(doc));
      } else if (tag !== 'style') {
        for (let child = el.firstChild; child; child = child.nextSibling) {
          const encoded = serNode(child);
          if (encoded !== null) node.push(encoded);
        }
      }
      return Codec.seal(node, true);
    }

    function serAttributes(el, tag) {
      const list = el.attributes;
      let out = null;
      const formField = tag === 'input' || tag === 'textarea' || tag === 'select';
      const masked = formField && isMasked(el);
      const add = (name, value) => { (out || (out = [])).push(intern(name), intern(value)); };
      for (let i = 0; i < list.length; i++) {
        const attr = list[i];
        const name = attr.name;
        if (isHandlerAttribute(name)) continue;
        add(name, masked && name === 'value' ? mask(attr.value) : attr.value);
      }
      if (formField) {
        if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          if (el.checked !== el.hasAttribute('checked')) add('__checked', el.checked ? '1' : '0');
          lastInput.set(el, el.checked ? '1' : '0');
        } else if (tag === 'select') {
          const option = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
          if (option && !option.hasAttribute('selected')) add('__value', el.value);
          lastInput.set(el, el.value);
        } else if (el.type !== 'file') {
          const value = masked ? mask(el.value) : el.value;
          const initial = tag === 'textarea' ? el.defaultValue : (el.getAttribute('value') || '');
          if (value !== (masked ? mask(initial) : initial)) add('__value', value);
          lastInput.set(el, value);
        }
      } else if (tag === 'style' || (tag === 'link' && isStylesheetLink(el))) {
        const css = cssOf(el);
        if (css !== null) { add('__css', css); lastCss.set(el, css); }
      }
      return out || 0;
    }

    function cssOf(el) {
      const sheet = el.sheet;
      if (el.localName === 'style') {
        const text = el.textContent || '';
        if (sheet && editedSheets.has(sheet)) { const fromRules = sheetText(sheet, null); if (fromRules !== null) return fromRules; }
        if (text) return text;
        return sheet ? (sheetText(sheet, null) || '') : '';
      }
      if (!sheet) return null;
      return sheetText(sheet, el.href);
    }

    function serShadow(shadow) {
      ids.set(shadow, nextId++);
      observeRoot(shadow);
      listenShadow(shadow);
      const children = [];
      for (let child = shadow.firstChild; child; child = child.nextSibling) {
        const encoded = serNode(child);
        if (encoded !== null) children.push(encoded);
      }
      return Codec.sealSpecial({ r: children });
    }

    function serDocument(doc) {
      ids.set(doc, nextId++);
      observeRoot(doc);
      listenDocument(doc);
      const children = [];
      for (let child = doc.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 10) continue;
        const encoded = serNode(child);
        if (encoded !== null) children.push(encoded);
      }
      const doctype = doc.doctype;
      return Codec.sealSpecial({ d: children, u: intern(doc.URL), t: doctype ? intern(doctypeText(doctype)) : -1 });
    }

    function frameDocument(frame) {
      try {
        const doc = frame.contentDocument;
        return doc && doc.documentElement ? doc : null;
      } catch (error) {
        return null;
      }
    }

    const watchedFrames = new WeakSet();
    function watchFrame(frame) {
      if (watchedFrames.has(frame)) return;
      watchedFrames.add(frame);
      frame.addEventListener('load', timed(() => { frameLoads.add(frame); scheduleFlush(); }));
    }

    function observeRoot(node) {
      if (mo) mo.observe(node, MO_OPTIONS);
    }

    // -------------------------------------------------------------------------
    // Listeners. Installed once per document; handlers read the current state.
    // -------------------------------------------------------------------------
    const listenedDocs = new WeakSet();
    const listenedShadows = new WeakSet();
    let handlers = null;

    function listenDocument(doc) {
      if (listenedDocs.has(doc)) return;
      listenedDocs.add(doc);
      const h = handlers;
      doc.addEventListener('pointermove', h.pointerMove, LISTEN);
      doc.addEventListener('pointerdown', h.pointerDown, LISTEN);
      doc.addEventListener('pointerup', h.pointerUp, LISTEN);
      doc.addEventListener('click', h.click, LISTEN);
      doc.addEventListener('dblclick', h.dblclick, LISTEN);
      doc.addEventListener('contextmenu', h.contextmenu, LISTEN);
      doc.addEventListener('pointerover', h.pointerOver, LISTEN);
      doc.addEventListener('pointerout', h.pointerOut, LISTEN);
      doc.addEventListener('keydown', h.keyDown, LISTEN);
      doc.addEventListener('input', h.input, LISTEN);
      doc.addEventListener('change', h.input, LISTEN);
      doc.addEventListener('focusin', h.focus, LISTEN);
      doc.addEventListener('focusout', h.focus, LISTEN);
      doc.addEventListener('scroll', h.scroll, LISTEN);
      doc.addEventListener('load', h.resourceLoad, LISTEN);
      patchWindow(doc.defaultView);
    }

    function listenShadow(shadow) {
      if (listenedShadows.has(shadow)) return;
      listenedShadows.add(shadow);
      // These do not cross a shadow boundary.
      shadow.addEventListener('change', handlers.input, LISTEN);
      shadow.addEventListener('scroll', handlers.scroll, LISTEN);
      shadow.addEventListener('load', handlers.resourceLoad, LISTEN);
    }

    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------
    function onMutations(records) {
      if (!state.recording) return;
      const start = perf.now();
      if (!moFirstT) moFirstT = clock();
      for (let i = 0; i < records.length; i++) moPending.push(records[i]);
      diag.mutations += records.length;
      if (moPending.length > 20000) flushMutations();
      else scheduleFlush();
      if (!depth) diag.cpu_ms += perf.now() - start;
    }

    function scheduleFlush() {
      if (!moTimer) moTimer = setTimeout(timed(flushMutations), 40);
    }

    function flushMutations() {
      if (!pausing && options.pageAllowed && !allowedHere()) { pause(); return; }
      if (mo) {
        const extra = mo.takeRecords();
        if (extra.length) {
          if (!moFirstT) moFirstT = clock();
          for (let i = 0; i < extra.length; i++) moPending.push(extra[i]);
          diag.mutations += extra.length;
        }
      }
      if (moTimer) { clearTimeout(moTimer); moTimer = 0; }
      if (!moPending.length && !dirtyInputs.size && !dirtyStyles.size && !newShadows.length && !frameLoads.size) return;
      const started = perf.now();
      const at = moFirstT || clock();
      const records = moPending;
      moPending = [];
      moFirstT = 0;
      const flushBase = nextId;

      const removes = [];
      const removedIds = new Set();
      const added = new Set();
      const attrs = new Map();
      const texts = new Set();
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const target = record.target;
        if (record.type === 'childList') {
          if (target.localName === 'style') { dirtyStyles.add(target); continue; }
          const removed = record.removedNodes;
          for (let k = 0; k < removed.length; k++) {
            const id = ids.get(removed[k]);
            if (id !== undefined && !removedIds.has(id)) { removedIds.add(id); removes.push(id); }
          }
          const addedNodes = record.addedNodes;
          for (let k = 0; k < addedNodes.length; k++) added.add(addedNodes[k]);
        } else if (record.type === 'attributes') {
          if (!ids.has(target)) continue;
          let names = attrs.get(target);
          if (!names) attrs.set(target, names = new Set());
          names.add(record.attributeName);
        } else {
          const parent = target.parentNode;
          if (parent && parent.localName === 'style') { dirtyStyles.add(parent); continue; }
          texts.add(target);
        }
      }

      // Shadow roots attached to hosts already written.
      for (let i = 0; i < newShadows.length; i++) {
        const host = newShadows[i];
        const hostId = ids.get(host);
        const shadow = host.shadowRoot || closedShadows.get(host);
        if (hostId === undefined || hostId >= flushBase || !shadow || ids.has(shadow) || !host.isConnected) continue;
        const base = nextId;
        push([at, E.SHADOW, hostId, base, Codec.encodeTree(serShadow(shadow), templates, encodeStats)]);
      }
      newShadows.length = 0;

      // Same-origin iframes that loaded a new document.
      for (const frame of frameLoads) {
        const frameId = ids.get(frame);
        if (frameId === undefined || frameId >= flushBase || !frame.isConnected) continue;
        const doc = frameDocument(frame);
        if (!doc || ids.has(doc)) continue;
        const base = nextId;
        push([at, E.FRAME, frameId, base, Codec.encodeTree(serDocument(doc), templates, encodeStats)]);
      }
      frameLoads.clear();

      // Added subtrees: the topmost added node under a recorded parent, written as
      // it is now (later changes inside it are already part of it).
      const byParent = new Map();
      for (const node of added) {
        if (!node.isConnected) continue;
        const existing = ids.get(node);
        if (existing !== undefined && existing >= flushBase) continue;
        const parent = node.parentNode;
        if (!parent) continue;
        const parentId = ids.get(parent);
        if (parentId === undefined || parentId >= flushBase) continue;
        if (parent.localName === 'style') { dirtyStyles.add(parent); continue; }
        if (parent.localName === 'iframe' || parent.localName === 'frame') continue;
        let covered = false;
        for (let up = parent; up; up = up.parentNode || up.host) {
          if (added.has(up)) { covered = true; break; }
        }
        if (covered) continue;
        let list = byParent.get(parent);
        if (!list) byParent.set(parent, list = []);
        list.push(node);
      }
      const adds = [];
      for (const [parent, list] of byParent) {
        if (list.length > 1) {
          const order = new Map();
          let index = 0;
          for (let child = parent.firstChild; child; child = child.nextSibling) order.set(child, index++);
          list.sort((a, b) => order.get(a) - order.get(b));
        }
        const parentId = ids.get(parent);
        for (let i = list.length - 1; i >= 0; i--) {
          const node = list[i];
          let next = node.nextSibling;
          while (next && !ids.has(next)) next = next.nextSibling;
          const nextRef = next ? ids.get(next) : 0;
          const base = nextId;
          const encoded = serNode(node);
          if (encoded === null) continue;
          adds.push(parentId, nextRef, base, Codec.encodeTree(encoded, templates, encodeStats));
        }
      }

      const attrOut = [];
      for (const [el, names] of attrs) {
        const id = ids.get(el);
        if (id === undefined || id >= flushBase || !el.isConnected) continue;
        const formField = el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select';
        for (const name of names) {
          if (isHandlerAttribute(name)) continue;
          let value = el.getAttribute(name);
          if (value !== null && name === 'value' && formField && isMasked(el)) value = mask(value);
          attrOut.push(id, intern(name), value === null ? -1 : intern(value));
          if (el.localName === 'link' && (name === 'href' || name === 'rel')) dirtyStyles.add(el);
        }
      }

      const textOut = [];
      for (const node of texts) {
        const id = ids.get(node);
        if (id === undefined || id >= flushBase || !node.isConnected) continue;
        textOut.push(id, intern(node.data));
      }

      for (const el of dirtyStyles) {
        const id = ids.get(el);
        if (id === undefined || id >= flushBase || !el.isConnected) continue;
        const css = cssOf(el);
        if (css === null || lastCss.get(el) === css) continue;
        lastCss.set(el, css);
        attrOut.push(id, intern('__css'), intern(css));
      }
      dirtyStyles.clear();

      if (removes.length || adds.length || attrOut.length || textOut.length) {
        push([at, E.MUT, removes.length ? removes : 0, adds.length ? adds : 0, attrOut.length ? attrOut : 0, textOut.length ? textOut : 0]);
      }

      if (dirtyInputs.size) {
        const t = clock();
        for (const el of dirtyInputs) emitInput(el, t, flushBase);
        dirtyInputs.clear();
      }

      const spent = perf.now() - started;
      diag.flushes++;
      diag.flush_ms += spent;
      if (spent > diag.flush_max_ms) diag.flush_max_ms = spent;
      if (stringChars > MAX_STRING_CHARS) restartPage('string_table_full');
    }

    function emitInput(el, t, flushBase) {
      const id = ids.get(el);
      if (id === undefined || id >= flushBase || !el.isConnected) return;
      if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        const value = el.checked ? '1' : '0';
        if (lastInput.get(el) === value) return;
        lastInput.set(el, value);
        push([t, E.INPUT, id, 1, el.checked ? 1 : 0]);
        return;
      }
      if (el.type === 'file') return;
      let value = String(el.value == null ? '' : el.value);
      if (isMasked(el)) value = mask(value);
      const before = lastInput.get(el);
      if (before === value) return;
      lastInput.set(el, value);
      if (typeof before === 'string' && el.localName !== 'select') {
        const splice = Codec.textSplice(before, value);
        if (splice && splice[2].length + 12 < value.length) {
          push([t, E.INPUT, id, 2, splice[0], splice[1], intern(splice[2])]);
          return;
        }
      }
      push([t, E.INPUT, id, 0, intern(value)]);
    }

    // -------------------------------------------------------------------------
    // Pointer, keys, focus, scroll, viewport, navigation
    // -------------------------------------------------------------------------
    const frameOffsets = new Map();
    let frameOffsetsAt = 0;
    function offsetOf(doc) {
      if (!doc || doc === topDoc) return ZERO;
      const now = perf.now();
      if (now - frameOffsetsAt > 250) { frameOffsets.clear(); frameOffsetsAt = now; }
      let offset = frameOffsets.get(doc);
      if (offset) return offset;
      let x = 0, y = 0;
      try {
        let win = doc.defaultView;
        while (win && win !== topWin) {
          const frame = win.frameElement;
          if (!frame) break;
          const rect = frame.getBoundingClientRect();
          x += rect.left + frame.clientLeft;
          y += rect.top + frame.clientTop;
          win = frame.ownerDocument.defaultView;
        }
      } catch (error) { /* cross-origin parent */ }
      offset = [x, y];
      frameOffsets.set(doc, offset);
      return offset;
    }

    function addPoint(t, x, y) {
      x = Math.round(x); y = Math.round(y);
      const previous = lastPoint;
      if (previous && t - previous[0] > 100) {
        // The pointer rested at its last position until just before this sample.
        mouse.push(Math.max(previous[0], t - 16), previous[1], previous[2]);
      }
      mouse.push(t, x, y);
      lastPoint = [t, x, y];
      if (mouse.length > 6000) mouse = Codec.simplifyPath(mouse, 1.5);
    }

    function idOf(node) {
      for (let n = node; n; n = n.parentNode || n.host) {
        const id = ids.get(n);
        if (id !== undefined) return id;
      }
      return 0;
    }

    function knownId(node) {
      let id = idOf(node);
      if (node && !ids.has(node) && (moPending.length || moTimer)) { flushMutations(); id = idOf(node); }
      return id;
    }

    function labelOf(node) {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      if (!el || !el.closest) return '';
      const target = el.closest('a,button,[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="link"],[role="checkbox"],[role="switch"],input,select,textarea,label,summary,option') || el;
      let text = target.getAttribute('aria-label') || target.getAttribute('title') || '';
      if (!text) {
        if (target.localName === 'input' || target.localName === 'textarea' || target.localName === 'select') {
          text = target.getAttribute('placeholder') || target.getAttribute('name') || target.type || target.localName;
        } else if (target === el && el.childElementCount > 12) {
          for (let child = el.firstChild; child; child = child.nextSibling) if (child.nodeType === 3) text += child.data;
        } else {
          text = target.textContent || '';
        }
      }
      return text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    function pathOf(node) {
      const parts = [];
      let el = node && (node.nodeType === 1 ? node : node.parentElement);
      for (let depthCount = 0; el && el.nodeType === 1 && depthCount < 4; depthCount++) {
        let part = el.localName;
        if (el.id) part += '#' + el.id;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) part += '.' + cls.join('.');
        parts.unshift(part);
        if (el.id) break;
        el = el.parentElement || (el.parentNode && el.parentNode.host) || null;
      }
      return parts.join(' > ');
    }

    function pointer(kind) {
      return timed((event) => {
        flushMutations();
        const t = clock();
        const target = deepTarget(event);
        const offset = offsetOf(docOf(target));
        const keyboardClick = kind === PTR.CLICK && event.detail === 0 && !event.clientX && !event.clientY;
        const x = keyboardClick ? -1 : Math.round(event.clientX + offset[0]);
        const y = keyboardClick ? -1 : Math.round(event.clientY + offset[1]);
        if (!keyboardClick) addPoint(t, x, y);
        const record = [t, E.PTR, kind, idOf(target), x, y, event.button | 0, POINTER_TYPES[event.pointerType] || 0];
        if (kind === PTR.CLICK || kind === PTR.CONTEXTMENU) record.push(intern(labelOf(target)), intern(pathOf(target)));
        push(record);
      });
    }

    function checkFocus() {
      focusQueued = false;
      let el = topDoc.activeElement;
      for (let guard = 0; el && guard < 20; guard++) {
        if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
        if (el.localName === 'iframe') { const doc = frameDocument(el); if (doc && doc.activeElement && doc.activeElement !== doc.body) { el = doc.activeElement; continue; } }
        break;
      }
      const doc = docOf(el);
      const id = el && doc && el !== doc.body && el !== doc.documentElement ? knownId(el) : 0;
      if (id === focusId) return;
      focusId = id;
      let visible = 0;
      try { visible = el && el.matches(':focus-visible') ? 1 : 0; } catch (error) { visible = 0; }
      push([clock(), E.FOCUS, id, visible]);
    }
    const timedCheckFocus = timed(checkFocus);

    // Scroll positions are sampled at most every 100 ms but stamped with the time of
    // the last scroll event, and written before any later event.
    function flushScroll() {
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = 0; }
      if (!pendingScroll.size) return;
      const entries = Array.from(pendingScroll).sort((a, b) => a[1] - b[1]);
      pendingScroll.clear();
      for (const [target, t] of entries) {
        let x, y;
        if (target.nodeType === 9) {
          const win = target.defaultView;
          if (!win) continue;
          x = win.scrollX; y = win.scrollY;
        } else {
          x = target.scrollLeft; y = target.scrollTop;
        }
        const id = knownId(target);
        if (!id || (target.nodeType !== 9 && ids.get(target) !== id)) continue;
        x = Math.round(x); y = Math.round(y);
        const last = lastScroll.get(target);
        if (last && last[0] === x && last[1] === y) continue;
        lastScroll.set(target, [x, y]);
        push([t, E.SCROLL, id, x, y]);
      }
    }

    function viewState() {
      const vv = topWin.visualViewport;
      return [topWin.innerWidth, topWin.innerHeight, Math.round((topWin.devicePixelRatio || 1) * 100),
        vv ? Math.round(vv.scale * 1000) : 1000, vv ? Math.round(vv.offsetLeft) : 0, vv ? Math.round(vv.offsetTop) : 0];
    }
    function checkView() {
      viewTimer = 0;
      const view = viewState();
      const key = view.join(',');
      if (key === lastView) return;
      lastView = key;
      frameOffsetsAt = 0;
      push([clock(), E.VIEW].concat(view));
    }
    const timedCheckView = timed(checkView);
    const timedNoteUrl = timed(() => noteUrl());

    function noteUrl() {
      const href = topWin.location.href;
      if (href === lastUrl) return;
      if (!allowedHere()) { pause(); return; }
      lastUrl = href;
      flushMutations();
      push([clock(), E.NAV, intern(href)]);
      notePath();
    }

    // Leaving for a page that is not recorded: nothing more of this page is kept (changes not yet written are
    // dropped, not flushed), a marker says why the recording stops here, and it resumes when the person leaves.
    function pause() {
      if (!state.recording || pausing) return;
      pausing = true;
      try {
        if (mo) { mo.takeRecords(); mo.disconnect(); }
        moPending = []; moFirstT = 0;
        dirtyInputs.clear(); dirtyStyles.clear(); newShadows.length = 0; frameLoads.clear(); pendingScroll.clear();
        mouse = [];
        push([clock(), E.CUSTOM, intern('Recording paused'), intern('This page is not recorded.')]);
        cutChunk();
      } finally { pausing = false; }
      [moTimer, scrollTimer, viewTimer, firstChunkTimer].forEach((timer) => timer && clearTimeout(timer));
      moTimer = 0; scrollTimer = 0; viewTimer = 0; firstChunkTimer = 0;
      state.recording = false;
      state.paused = true;
      pump();
    }

    function checkResume() {
      if (!state.paused || !allowedHere()) return;
      state.paused = false;
      state.pageId = randomId(10);
      state.pageStartedAt = Date.now();
      begin();
      scheduleChunk(intervalMs);
    }

    handlers = {
      pointerMove: timed((event) => {
        const offset = offsetOf(docOf(event.target));
        addPoint(clock(), event.clientX + offset[0], event.clientY + offset[1]);
      }),
      pointerDown: pointer(PTR.DOWN),
      pointerUp: pointer(PTR.UP),
      click: pointer(PTR.CLICK),
      dblclick: pointer(PTR.DBLCLICK),
      contextmenu: pointer(PTR.CONTEXTMENU),
      pointerOver: timed((event) => {
        const id = knownId(deepTarget(event));
        if (id === hoverId) return;
        hoverId = id;
        push([clock(), E.HOVER, id]);
      }),
      pointerOut: timed((event) => {
        if (event.relatedTarget || docOf(event.target) !== topDoc) return;
        hoverId = 0;
        push([clock(), E.HOVER, 0]);
      }),
      keyDown: timed((event) => {
        flushMutations();
        const key = String(event.key || '');
        const modifiers = (event.ctrlKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.shiftKey ? 4 : 0) | (event.metaKey ? 8 : 0);
        const printable = key.length === 1 && !(modifiers & 11);
        push([clock(), E.KEY, intern(printable ? 'char' : key), modifiers, idOf(deepTarget(event))]);
      }),
      input: timed((event) => {
        const el = deepTarget(event);
        if (!el || el.nodeType !== 1) return;
        const tag = el.localName;
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
        dirtyInputs.add(el);
        flushMutations();
      }),
      focus: timed(() => {
        if (focusQueued) return;
        focusQueued = true;
        (root.queueMicrotask || ((fn) => Promise.resolve().then(fn)))(timedCheckFocus);
      }),
      scroll: timed((event) => {
        pendingScroll.set(event.target, clock());
        frameOffsetsAt = 0;
        if (!scrollTimer) scrollTimer = setTimeout(timed(flushScroll), 100);
      }),
      resourceLoad: timed((event) => {
        const el = event.target;
        if (el && el.localName === 'link' && isStylesheetLink(el) && ids.has(el)) { dirtyStyles.add(el); scheduleFlush(); }
      }),
      view: timed(() => { if (!viewTimer) viewTimer = setTimeout(timedCheckView, 150); }),
      nav: (event) => { if (state.paused) checkResume(); else timedNoteUrl(event); },
      visibility: timed(() => {
        flushMutations();
        push([clock(), E.VIS, topDoc.hidden ? 1 : 0]);
        if (topDoc.hidden) { cutChunk(); pump(); }
      }),
      pageHide: (event) => {
        if (!state.recording) return;
        push([clock(), E.END]);
        cutChunk();
        beaconAll();
        if (event && event.persisted) state.frozen = true;
      },
      pageShow: (event) => {
        if (event && event.persisted && state.frozen) {
          state.frozen = false;
          restartPage('back_forward_cache');
        }
      }
    };

    // -------------------------------------------------------------------------
    // Chunks and uploads
    // -------------------------------------------------------------------------
    function cutChunk() {
      if (!state.recording) return null;
      flushMutations();
      flushScroll();
      // The first chunk and any chunk after 5 quiet-diagnostic seconds carry a DIAG sample.
      if (events.length && (!lastStreamDiag || clock() - lastStreamDiag >= 5000)) pushDiag();
      const track = mouse.length >= 3 ? Codec.simplifyPath(mouse, 1.5) : mouse;
      mouse = [];
      if (!events.length && !track.length && !pendingStrings.length) return null;
      const firstT = Math.min(events.length ? events[0][0] : Infinity, track.length ? track[0] : Infinity);
      let lastT = firstT;
      const out = new Array(events.length);
      let previous = firstT;
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const t = event[0];
        event[0] = t - previous;
        previous = t;
        out[i] = event;
        if (t > lastT) lastT = t;
      }
      const m = [];
      let pt = firstT, px = 0, py = 0;
      for (let i = 0; i < track.length; i += 3) {
        m.push(track[i] - pt, track[i + 1] - px, track[i + 2] - py);
        pt = track[i]; px = track[i + 1]; py = track[i + 2];
        if (pt > lastT) lastT = pt;
      }
      const chunk = { v: Codec.FORMAT, t: timeOrigin + firstT, s: pendingStrings, e: out, m };
      const item = {
        session_id: state.sessionId, page_id: state.pageId, seq: seq++, page_started_at: state.pageStartedAt,
        t_start: timeOrigin + firstT, t_end: timeOrigin + lastT, events: out.length,
        json: JSON.stringify(chunk), raw_bytes: 0, bytes: null, meta: null, paths: pathsPending
      };
      if (item.seq === 0) item.meta = pageMeta();
      events = [];
      pendingStrings = [];
      pathsPending = [];
      queue.push(item);
      if (queue.length > MAX_QUEUE) stop('upload_backlog');
      return item;
    }

    function flushBlobs() {
      if (!blobPromise) blobPromise = sendBlobs().finally(() => { blobPromise = null; });
      return blobPromise;
    }

    // A stylesheet seen for the first time goes up at once rather than with the next chunk: a page about to be left
    // (a checkout, signing out) would otherwise take it along, and its replay would lose those styles.
    function scheduleBlobs() {
      if (blobTimer) return;
      blobTimer = setTimeout(() => { blobTimer = 0; if (pendingBlobs.size) flushBlobs().catch(() => {}); }, 50);
    }

    async function sendBlobs() {
      const keys = Array.from(pendingBlobs.keys());
      if (!keys.length) return true;
      let missing;
      try { missing = await transport.missingBlobs(keys); } catch (error) { return false; }
      const want = new Set(missing || keys);
      for (const key of keys) if (!want.has(key)) { knownBlobs.add(key); pendingBlobs.delete(key); }
      for (const key of want) {
        const text = pendingBlobs.get(key);
        if (text === undefined) continue;
        const packed = await gzip(text);
        let result;
        try {
          result = await transport.sendBlob({ key, raw_bytes: packed.raw, encoding: packed.compressed ? 'gzip' : 'identity', bytes: packed.bytes });
        } catch (error) { return false; }
        if (!result || !result.ok) return false;
        knownBlobs.add(key);
        pendingBlobs.delete(key);
        diag.blobs++;
        diag.blob_raw_bytes += packed.raw;
        diag.blob_gzip_bytes += packed.bytes.length;
      }
      if (options.onKnownBlobs) { try { options.onKnownBlobs(Array.from(knownBlobs)); } catch (error) { /* storage full */ } }
      return true;
    }

    function sendNow() {
      try { cutChunk(); } catch (error) { diag.internal_errors++; }
      return pump();
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length) {
          if (pendingBlobs.size && !(await flushBlobs())) { retry(); return; }
          const item = queue[0];
          if (!item.bytes) {
            const started = perf.now();
            const packed = await gzip(item.json);
            diag.cpu_ms += perf.now() - started;
            item.raw_bytes = packed.raw;
            item.encoding = packed.compressed ? 'gzip' : 'identity';
            item.bytes = packed.bytes;
            item.stored_bytes = packed.bytes.length;
          }
          const started = perf.now();
          let result;
          try { result = await transport.sendChunk(item); } catch (error) { result = { ok: false, status: 0 }; }
          diag.last_upload_ms = perf.now() - started;
          diag.upload_ms += diag.last_upload_ms;
          if (result && result.ok) {
            if (queue[0] === item) queue.shift();
            diag.chunks++;
            diag.raw_bytes += item.raw_bytes;
            diag.gzip_bytes += item.stored_bytes;
            backoff = 0;
            pace(result.next_ms || (result.data && result.data.next_ms));
            if (options.onUploaded) { try { options.onUploaded(item); } catch (error) { /* ignore */ } }
            continue;
          }
          diag.failures++;
          const status = result ? result.status : 0;
          if (status === 401 || status === 403) { stop('not_allowed'); return; }
          if (status === 409) { queue.length = 0; restartSession(); return; }
          if (status === 413) { stop('session_full'); return; }
          if (status === 400) { queue.shift(); restartPage('chunk_rejected'); continue; }
          retry();
          return;
        }
      } catch (error) {
        // Never let an upload problem reach the page's own error handlers.
        diag.internal_errors++;
        retry();
      } finally {
        pumping = false;
      }
    }

    function scheduleChunk(ms) {
      if (chunkTimer) clearTimeout(chunkTimer);
      chunkTimer = setTimeout(() => {
        chunkTimer = 0;
        if (!state.recording) return;
        if (!topDoc.hidden) sendNow();
        scheduleChunk(intervalMs);
      }, ms);
    }

    // Upload more or less often from now on (a reply's next_ms, or hurry()).
    function pace(ms) {
      if (!ms) return;
      const next = clampInterval(ms, steadyMs);
      if (next === intervalMs) return;
      intervalMs = next;
      if (state.recording) scheduleChunk(next);
    }

    function retry() {
      if (retryTimer) return;
      backoff = Math.min(30000, backoff ? backoff * 2 : 1000);
      retryTimer = setTimeout(() => { retryTimer = 0; pump(); }, backoff);
    }

    function beaconAll() {
      // Stylesheets still waiting go first, uncompressed: compressing is asynchronous and the page is closing.
      for (const [key, text] of pendingBlobs) {
        try { if (transport.beaconBlob) { const bytes = utf8.encode(text); transport.beaconBlob({ key, raw_bytes: bytes.length, encoding: 'identity', bytes }); } } catch (error) { /* page is leaving */ }
      }
      while (queue.length) {
        const item = queue.shift();
        try { transport.beacon(item); } catch (error) { /* page is leaving */ }
      }
    }

    function pageMeta() {
      const nav = (perf.getEntriesByType && perf.getEntriesByType('navigation')[0]) || null;
      const ua = navigator.userAgentData;
      const connection = navigator.connection;
      const screenInfo = topWin.screen || {};
      return {
        recorder: VERSION,
        url: topWin.location.href,
        title: topDoc.title,
        referrer: topDoc.referrer,
        user_agent: navigator.userAgent,
        platform: (ua && ua.platform) || navigator.platform || '',
        mobile: ua ? !!ua.mobile : /Mobi|Android|iPhone|iPad/.test(navigator.userAgent),
        brands: ua && ua.brands ? ua.brands.map((brand) => brand.brand + ' ' + brand.version) : [],
        language: navigator.language,
        languages: navigator.languages ? Array.from(navigator.languages) : [],
        timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (error) { return ''; } })(),
        screen: { width: screenInfo.width, height: screenInfo.height, avail_width: screenInfo.availWidth, avail_height: screenInfo.availHeight, color_depth: screenInfo.colorDepth },
        viewport: { width: topWin.innerWidth, height: topWin.innerHeight },
        device_pixel_ratio: topWin.devicePixelRatio || 1,
        touch_points: navigator.maxTouchPoints || 0,
        cores: navigator.hardwareConcurrency || 0,
        memory_gb: navigator.deviceMemory || 0,
        connection: connection ? { type: connection.effectiveType || '', downlink: connection.downlink || 0, rtt: connection.rtt || 0, save_data: !!connection.saveData } : null,
        color_scheme: topWin.matchMedia && topWin.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        reduced_motion: !!(topWin.matchMedia && topWin.matchMedia('(prefers-reduced-motion: reduce)').matches),
        navigation: nav ? { type: nav.type, ttfb_ms: Math.round(nav.responseStart), dom_content_loaded_ms: Math.round(nav.domContentLoadedEventEnd), load_ms: Math.round(nav.loadEventEnd) } : null,
        snapshot_ms: Math.round(diag.snapshot_ms * 10) / 10,
        snapshot_nodes: diag.snapshot_nodes
      };
    }

    // -------------------------------------------------------------------------
    // Diagnostics
    // -------------------------------------------------------------------------
    function recorderBytes() {
      return stringChars * 2 + stringCount * 48 + templates.list.length * 64 + nextId * 24 + mouse.length * 8
        + queue.reduce((sum, item) => sum + item.json.length * 2 + (item.bytes ? item.bytes.length : 0), 0);
    }

    function heap() {
      const memory = perf.memory;
      return memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null;
    }

    function delta(cursor) {
      const now = clock();
      const out = {
        window_ms: Math.max(1, now - cursor.t),
        cpu_ms: diag.cpu_ms - cursor.cpu,
        long_tasks: diag.long_tasks - cursor.long,
        long_task_ms: diag.long_task_ms - cursor.longMs,
        mutations: diag.mutations - cursor.mutations,
        events: diag.events - cursor.events
      };
      cursor.t = now; cursor.cpu = diag.cpu_ms; cursor.long = diag.long_tasks; cursor.longMs = diag.long_task_ms;
      cursor.mutations = diag.mutations; cursor.events = diag.events;
      return out;
    }

    let lagExpected = 0;
    let lagMax = 0;
    let lastStreamDiag = 0;
    function sample() {
      const now = perf.now();
      const lag = lagExpected ? Math.max(0, now - lagExpected) : 0;
      lagMax = Math.max(lagMax, lag);
      lagExpected = now + 1000;
      const d = delta(sampleCursor);
      const memory = heap();
      samples.push({ t: clock(), cpu_pct: (d.cpu_ms / d.window_ms) * 100, cpu_ms: d.cpu_ms, heap_mb: memory ? memory.used / 1048576 : 0,
        gzip_bytes: diag.gzip_bytes, raw_bytes: diag.raw_bytes, events: d.events, mutations: d.mutations, lag_ms: lag });
      if (samples.length > 300) samples.shift();
      const since = clock() - lastStreamDiag;
      if (since >= 60000 || (streamCursor.events !== diag.events && since >= 5000)) pushDiag();
    }

    // A DIAG event: the recorder's cost since the last one, and the page's state now.
    function pushDiag() {
      const s = delta(streamCursor);
      const memory = heap();
      lastStreamDiag = clock();
      push([clock(), E.DIAG, Math.round(s.cpu_ms * 10), s.window_ms, memory ? Math.round(memory.used / 1024) : 0,
        memory ? Math.round(memory.total / 1024) : 0, topDoc.getElementsByTagName('*').length, stringCount, templates.list.length,
        diag.raw_bytes, diag.gzip_bytes, s.long_tasks, Math.round(s.long_task_ms), Math.round(lagMax), Math.round(recorderBytes() / 1024), s.mutations]);
      streamCursor.events = diag.events;
      lagMax = 0;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    function snapshot() {
      const started = perf.now();
      const base = nextId;
      const t = clock();
      push([t, E.META, intern(JSON.stringify(pageMeta()))]);
      const docNode = serDocument(topDoc);
      push([t, E.SNAPSHOT, base, Codec.encodeTree(docNode, templates, encodeStats)]);
      diag.snapshot_nodes = docNode.$n;
      diag.snapshot_ms = perf.now() - started;
      lastUrl = topWin.location.href;
      notePath();
      checkView();
      const scrollX = Math.round(topWin.scrollX), scrollY = Math.round(topWin.scrollY);
      lastScroll.set(topDoc, [scrollX, scrollY]);
      if (scrollX || scrollY) push([t, E.SCROLL, ids.get(topDoc), scrollX, scrollY]);
      checkFocus();
      diag.pages++;
    }

    let topListening = false;
    function listenTop() {
      if (topListening) return;
      topListening = true;
      topWin.addEventListener('resize', handlers.view, { passive: true });
      if (topWin.visualViewport) {
        topWin.visualViewport.addEventListener('resize', handlers.view, { passive: true });
        topWin.visualViewport.addEventListener('scroll', handlers.view, { passive: true });
      }
      topWin.addEventListener('popstate', handlers.nav);
      topWin.addEventListener('hashchange', handlers.nav);
      topDoc.addEventListener('visibilitychange', handlers.visibility);
      topWin.addEventListener('pagehide', handlers.pageHide);
      topWin.addEventListener('pageshow', handlers.pageShow);
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) { diag.long_tasks++; diag.long_task_ms += entry.duration; }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch (error) { longTaskObserver = null; }
    }

    function begin() {
      resetPageState();
      mo = new (topWin.MutationObserver || root.MutationObserver)(onMutations);
      state.recording = true;
      active = api;
      const start = perf.now();
      depth++;
      try { snapshot(); } finally { depth--; diag.cpu_ms += perf.now() - start; }
      firstChunkTimer = setTimeout(() => { firstChunkTimer = 0; if (state.recording) sendNow(); }, 1000);
    }

    function start() {
      if (state.recording || state.paused) return api;
      listenTop();
      const timedSample = timed(sample);
      // The overlay draws outside timed(): its own cost is not the recorder's.
      diagTimer = setInterval(() => { timedSample(); if (overlay && overlay.visible) overlay.render(); }, 1000);
      if (!allowedHere()) { active = api; state.paused = true; return api; }
      begin();
      scheduleChunk(intervalMs);
      return api;
    }

    function restartPage(reason) {
      if (!state.recording) return;
      if (mo) mo.disconnect();
      state.recording = false;
      queue.length = 0;
      state.pageId = randomId(10);
      state.pageStartedAt = Date.now();
      state.restartReason = reason;
      if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = 0; }
      begin();
    }

    function restartSession() {
      state.sessionId = options.newSessionId ? options.newSessionId() : randomId(20);
      restartPage('session_conflict');
    }

    function stop(reason) {
      if (!state.recording && state.stopReason) return api;
      state.recording = false;
      state.paused = false;
      state.stopReason = reason || 'stopped';
      if (active === api) active = null;
      if (mo) mo.disconnect();
      [moTimer, scrollTimer, viewTimer, firstChunkTimer].forEach((timer) => timer && clearTimeout(timer));
      clearTimeout(chunkTimer);
      chunkTimer = 0;
      clearTimeout(blobTimer);
      blobTimer = 0;
      clearInterval(diagTimer);
      if (longTaskObserver) longTaskObserver.disconnect();
      if (reason === 'not_allowed' || reason === 'upload_backlog') queue.length = 0;
      if (options.onStop) { try { options.onStop(state.stopReason); } catch (error) { /* ignore */ } }
      if (overlay) overlay.render();
      return api;
    }

    function stats() {
      const elapsed = Math.max(1, clock() - diag.started_at);
      const memory = heap();
      const minutes = elapsed / 60000;
      return {
        recording: state.recording,
        paused: !!state.paused,
        stop_reason: state.stopReason,
        session_id: state.sessionId,
        page_id: state.pageId,
        recorder_version: VERSION,
        elapsed_ms: elapsed,
        cpu_ms: Math.round(diag.cpu_ms),
        cpu_percent: Math.round((diag.cpu_ms / elapsed) * 10000) / 100,
        snapshot_ms: Math.round(diag.snapshot_ms * 10) / 10,
        snapshot_nodes: diag.snapshot_nodes,
        flushes: diag.flushes,
        flush_avg_ms: diag.flushes ? Math.round((diag.flush_ms / diag.flushes) * 100) / 100 : 0,
        flush_max_ms: Math.round(diag.flush_max_ms * 10) / 10,
        mutation_records: diag.mutations,
        events: diag.events,
        strings: stringCount,
        string_chars: stringChars,
        templates: templates.list.length,
        encode: Object.assign({}, encodeStats),
        chunks_sent: diag.chunks,
        upload_interval_ms: intervalMs,
        chunks_queued: queue.length,
        upload_failures: diag.failures,
        last_upload_ms: Math.round(diag.last_upload_ms),
        raw_bytes: diag.raw_bytes,
        gzip_bytes: diag.gzip_bytes,
        compression_ratio: diag.gzip_bytes ? Math.round((diag.raw_bytes / diag.gzip_bytes) * 10) / 10 : 0,
        gzip_bytes_per_minute: Math.round(diag.gzip_bytes / minutes),
        blobs: diag.blobs,
        blob_raw_bytes: diag.blob_raw_bytes,
        blob_gzip_bytes: diag.blob_gzip_bytes,
        pending_blobs: pendingBlobs.size,
        recorder_memory_bytes: recorderBytes(),
        heap_used_bytes: memory ? memory.used : null,
        heap_total_bytes: memory ? memory.total : null,
        heap_limit_bytes: memory ? memory.limit : null,
        dom_elements: topDoc.getElementsByTagName('*').length,
        long_tasks: diag.long_tasks,
        long_task_ms: Math.round(diag.long_task_ms),
        internal_errors: diag.internal_errors,
        pages: diag.pages
      };
    }

    // -------------------------------------------------------------------------
    // Diagnostics overlay (FMReplay.overlay()). Not recorded: it carries
    // data-fmr-ignore and draws inside its own shadow root.
    // -------------------------------------------------------------------------
    let overlay = null;
    function createOverlay() {
      const host = topDoc.createElement('div');
      host.setAttribute('data-fmr-ignore', '');
      host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>'
        + ':host{all:initial}.panel{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6e8eb;background:rgba(17,19,23,.94);'
        + 'border:1px solid #2c3138;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);width:320px;padding:10px 12px;backdrop-filter:blur(6px)}'
        + '.head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-weight:600}.dot{width:8px;height:8px;border-radius:50%;background:#ef4444}'
        + '.dot.off{background:#6b7280}.grow{flex:1}button{all:unset;cursor:pointer;color:#9aa4b2;padding:0 4px}button:hover{color:#fff}'
        + '.row{display:flex;justify-content:space-between;gap:8px}.k{color:#9aa4b2}.sec{margin-top:6px;padding-top:6px;border-top:1px solid #262a30}'
        + 'canvas{display:block;width:100%;height:56px;margin-top:6px}.links{margin-top:8px;display:flex;gap:10px}.links button{color:#60a5fa}'
        + '</style><div class="panel"><div class="head"><span class="dot"></span><span class="grow">Session replay</span>'
        + '<button data-act="close" title="Hide (FMReplay.overlay(false))">&times;</button></div><div class="body"></div>'
        + '<canvas width="296" height="56"></canvas><div class="links"><button data-act="viewer">Open live viewer</button><button data-act="copy">Copy stats</button></div></div>';
      shadow.addEventListener('click', (event) => {
        const action = event.target && event.target.getAttribute && event.target.getAttribute('data-act');
        if (action === 'close') api.overlay(false);
        if (action === 'viewer' && options.openViewer) options.openViewer(state.sessionId);
        if (action === 'copy' && navigator.clipboard) navigator.clipboard.writeText(JSON.stringify(stats(), null, 2)).catch(() => {});
      });
      const body = shadow.querySelector('.body');
      const dot = shadow.querySelector('.dot');
      const canvas = shadow.querySelector('canvas');
      const kb = (bytes) => bytes == null ? 'n/a' : bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(2) + ' MB';
      const row = (key, value) => '<div class="row"><span class="k">' + key + '</span><span>' + value + '</span></div>';
      function render() {
        const s = stats();
        const last = samples[samples.length - 1];
        dot.className = 'dot' + (s.recording ? '' : ' off');
        const perHour = s.gzip_bytes_per_minute * 60;
        body.innerHTML = row('State', s.recording ? 'recording' : 'stopped (' + s.stop_reason + ')')
          + row('Session', s.session_id.slice(0, 10) + ' · page ' + s.page_id.slice(0, 6))
          + '<div class="sec"></div>'
          + row('Recorder CPU (now)', last ? last.cpu_pct.toFixed(2) + ' %' : '-')
          + row('Recorder CPU (total)', s.cpu_ms + ' ms · ' + s.cpu_percent.toFixed(2) + ' %')
          + row('Snapshot', s.snapshot_ms + ' ms · ' + s.snapshot_nodes + ' nodes')
          + row('Batches', s.flushes + ' · avg ' + s.flush_avg_ms + ' ms · max ' + s.flush_max_ms + ' ms')
          + row('Recorder memory', kb(s.recorder_memory_bytes))
          + row('Page JS heap', s.heap_used_bytes == null ? 'n/a' : kb(s.heap_used_bytes) + ' / ' + kb(s.heap_total_bytes))
          + row('DOM elements', s.dom_elements)
          + row('Long tasks', s.long_tasks + ' · ' + s.long_task_ms + ' ms')
          + row('Main-thread lag', last ? Math.round(last.lag_ms) + ' ms' : '-')
          + '<div class="sec"></div>'
          + row('Sent (gzip)', kb(s.gzip_bytes) + ' · raw ' + kb(s.raw_bytes) + ' · ' + (s.compression_ratio || '-') + '×')
          + row('Rate', kb(s.gzip_bytes_per_minute) + '/min · ' + kb(perHour) + '/hour')
          + row('Shared CSS blobs', s.blobs + ' · ' + kb(s.blob_gzip_bytes))
          + row('Strings · templates', s.strings + ' · ' + s.templates)
          + row('Template hits', s.encode.refs + ' exact · ' + s.encode.patches + ' patched')
          + row('Chunks', s.chunks_sent + ' sent · ' + s.chunks_queued + ' queued · ' + s.upload_failures + ' failed · every ' + Math.round(s.upload_interval_ms / 1000) + ' s');
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (samples.length > 1) {
          const recent = samples.slice(-120);
          const maxCpu = Math.max(2, ...recent.map((p) => p.cpu_pct));
          const maxHeap = Math.max(1, ...recent.map((p) => p.heap_mb));
          const plot = (key, max, color) => {
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
            recent.forEach((p, i) => { const x = (i / (recent.length - 1)) * (w - 2) + 1; const y = h - 2 - (p[key] / max) * (h - 18); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
            ctx.stroke();
          };
          plot('heap_mb', maxHeap * 1.1, '#60a5fa');
          plot('cpu_pct', maxCpu, '#f97316');
          ctx.fillStyle = '#f97316'; ctx.fillText('cpu ' + maxCpu.toFixed(1) + '% max', 4, 10);
          ctx.fillStyle = '#60a5fa'; ctx.fillText('heap', w - 30, 10);
        }
      }
      return {
        render,
        show() { if (!host.isConnected) (topDoc.body || topDoc.documentElement).appendChild(host); render(); },
        hide() { host.remove(); }
      };
    }

    const api = {
      version: VERSION,
      get sessionId() { return state.sessionId; },
      get pageId() { return state.pageId; },
      get recording() { return state.recording; },
      start,
      stop: (reason) => stop(reason || 'stopped'),
      flush() { cutChunk(); return pump(); },
      // Someone started following this session live: send now and keep sending often until a reply says otherwise.
      hurry(ms) {
        if (!state.recording) return Promise.resolve();
        pace(ms || 2000);
        return sendNow();
      },
      stats,
      samples: () => samples.slice(),
      overlay(on) {
        const show = on === undefined ? !(overlay && overlay.visible) : !!on;
        if (show) {
          if (!overlay) overlay = createOverlay();
          overlay.visible = true;
          overlay.show();
        } else if (overlay) {
          overlay.visible = false;
          overlay.hide();
        }
        if (options.onOverlay) { try { options.onOverlay(show); } catch (error) { /* ignore */ } }
        return show;
      },
      track(name, data) {
        if (!state.recording) return;
        push([clock(), E.CUSTOM, intern(String(name).slice(0, 120)), intern(JSON.stringify(data === undefined ? null : data).slice(0, 4000))]);
      },
      // Hooks called from the prototype patches.
      noteInput(el) { if (!state.recording) return; dirtyInputs.add(el); scheduleFlush(); },
      noteShadow(host, shadow) {
        if (!state.recording || !shadow) return;
        if (shadow.mode === 'closed') closedShadows.set(host, shadow);
        if (!ids.has(host)) return;
        newShadows.push(host);
        observeRoot(shadow);
        scheduleFlush();
      },
      noteSheet(sheet) {
        if (!state.recording) return;
        editedSheets.add(sheet);
        const owner = sheet.ownerNode;
        if (owner && ids.has(owner)) { dirtyStyles.add(owner); scheduleFlush(); }
      },
      noteUrl: () => { if (state.recording) timedNoteUrl(); else if (state.paused) checkResume(); },
      noteError(event) {
        if (!state.recording || !event || event.message === undefined || errorCount >= 100) return;
        errorCount++;
        push([clock(), E.ERR, intern(String(event.message || 'Error').slice(0, 500)), intern(String(event.filename || '').slice(0, 300)), event.lineno | 0, event.colno | 0]);
      },
      noteRejection(event) {
        if (!state.recording || errorCount >= 100) return;
        errorCount++;
        const reason = event && event.reason;
        const message = reason && reason.message ? reason.message : String(reason);
        push([clock(), E.ERR, intern(('Unhandled rejection: ' + message).slice(0, 500)), intern(reason && reason.stack ? String(reason.stack).split('\n')[1] || '' : ''), 0, 0]);
      }
    };
    return api;
  }

  root.FMReplayRecorder = { create, version: VERSION, base64 };
})();
