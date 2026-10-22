/* libraries/session-replay/session-replay-codec.js
 * The session replay wire format, shared by the recorder, the player and the tests.
 * See docs/architecture/session-replay.md.
 *
 * A page's DOM is tokenized once: every tag, attribute name, attribute value and
 * text is interned into a per-page string table and referred to by number. A node
 * is then a small array of numbers:
 *
 *   text node   s                          (a string id)
 *   element     [tag, attrs|0, ...children] (attrs = [name, value, name, value, ...])
 *   shadow root {r: [...children]}
 *   document    {d: [...children], u: urlStringId, t: doctypeStringId|-1}
 *
 * Second-order tokens: every element subtree of MIN_TEMPLATE_NODES or more nodes
 * that is written out in full becomes template n (in the order both sides finish
 * writing it). A later identical subtree is written as [-1 - n]; one with the same
 * structure and a few different values is [-1 - n, slot, value, slot, value, ...],
 * where a slot counts attribute values and texts in document order. Templates hold
 * no node ids: a subtree's ids are its base id plus its pre-order position.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FMReplayCodec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 1;
  const MIN_TEMPLATE_NODES = 3;
  const MAX_TEMPLATES = 60000;
  const BLOB_MIN_CHARS = 2048;
  const BLOB_PREFIX = '\u0001b:';

  // Event types. An event is [dtMs, type, ...args]; dt is from the previous event in
  // the chunk (the first from the chunk's start time).
  const E = {
    META: 0,      // [jsonSid]                           device, viewport, page
    SNAPSHOT: 1,  // [baseId, documentNode]
    MUT: 2,       // [removes|0, adds|0, attrs|0, texts|0] adds = [parentId, nextId|0, baseId, node, ...]
    PTR: 3,       // [kind, id, x, y, button, pointerType, labelSid?, pathSid?]
    SCROLL: 4,    // [id, x, y]
    VIEW: 5,      // [width, height, dpr*100, zoom*1000, zoomX, zoomY]
    INPUT: 6,     // [id, 0, valueSid] | [id, 1, checked] | [id, 2, at, deleteCount, insertSid]
    FOCUS: 7,     // [id|0, focusVisible]
    HOVER: 8,     // [id|0]
    KEY: 9,       // [keySid, modifiers, id]
    NAV: 10,      // [urlSid]
    VIS: 11,      // [hidden]
    ERR: 12,      // [messageSid, sourceSid, line, column]
    DIAG: 13,     // see DIAG_FIELDS
    FRAME: 14,    // [iframeId, baseId, documentNode]  an iframe loaded a new document
    SHADOW: 15,   // [hostId, baseId, shadowNode]      a shadow root attached after its host was written
    CUSTOM: 16,   // [nameSid, jsonSid]
    END: 17       // []                                 page hidden for good (pagehide)
  };
  const PTR = { DOWN: 0, UP: 1, CLICK: 2, DBLCLICK: 3, CONTEXTMENU: 4 };
  const DIAG_FIELDS = ['cpu_tenths_ms', 'window_ms', 'heap_used_kb', 'heap_total_kb', 'dom_nodes', 'strings',
    'templates', 'raw_bytes', 'gzip_bytes', 'long_tasks', 'long_task_ms', 'lag_ms', 'recorder_kb', 'mutations'];

  // ---------------------------------------------------------------------------
  // Hashing. Hashes only find candidates; every template hit is verified, so a
  // collision costs a comparison, never a wrong replay.
  // ---------------------------------------------------------------------------
  function mixA(h, v) {
    v = Math.imul(v | 0, 0xcc9e2d51);
    v = (v << 15) | (v >>> 17);
    v = Math.imul(v, 0x1b873593);
    h ^= v;
    h = (h << 13) | (h >>> 19);
    return (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  function mixB(h, v) {
    h = Math.imul(h ^ (v | 0) ^ ((v | 0) >>> 7), 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    return h ^ (h >>> 15);
  }
  function hashKey(a, b) {
    return (a >>> 0) * 2097152 + (b >>> 11);
  }

  // Content address for large strings (stylesheets, data URLs). The server
  // recomputes it before storing a blob (session-replay/hash.ts mirrors this).
  function cyrb(text, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return [h1 >>> 0, h2 >>> 0];
  }
  const hex8 = (n) => ('0000000' + n.toString(16)).slice(-8);
  function blobKey(text) {
    const a = cyrb(text, 0), b = cyrb(text, 0x5bd1e995);
    return 'b' + hex8(a[0]) + hex8(a[1]) + hex8(b[0]) + hex8(b[1]) + '-' + text.length.toString(36);
  }
  function isBlobRef(value) {
    return typeof value === 'string' && value.startsWith(BLOB_PREFIX);
  }

  // ---------------------------------------------------------------------------
  // Node arrays carry derived facts as non-index properties (JSON ignores them):
  // $n nodes, $v value slots, $t templatable (no shadow roots or documents inside),
  // and on the recorder side $a/$b (content hash) and $c/$d (shape hash).
  // ---------------------------------------------------------------------------
  const TEXT_SHAPE_A = 0x2545f491, TEXT_SHAPE_B = 0x4f6cdd1d;

  function seal(node, withHashes) {
    let n = 1, v = 0, t = true;
    const attrs = node[1];
    let a = 0, b = 0, c = 0, d = 0;
    if (withHashes) {
      a = mixA(0x3c6ef372, node[0]); b = mixB(0x1f83d9ab, node[0]);
      c = mixA(0x5be0cd19, node[0]); d = mixB(0x6a09e667, node[0]);
    }
    if (attrs) {
      v += attrs.length >> 1;
      if (withHashes) {
        for (let i = 0; i < attrs.length; i += 2) {
          a = mixA(mixA(a, attrs[i]), attrs[i + 1]);
          b = mixB(mixB(b, attrs[i]), attrs[i + 1]);
          c = mixA(c, attrs[i]);
          d = mixB(d, attrs[i]);
        }
      }
    }
    if (withHashes) {
      const marker = attrs ? attrs.length : 0x7fff;
      a = mixA(a, marker); b = mixB(b, marker); c = mixA(c, marker); d = mixB(d, marker);
    }
    for (let i = 2; i < node.length; i++) {
      const child = node[i];
      if (typeof child === 'number') {
        n += 1; v += 1;
        if (withHashes) {
          a = mixA(a, ~child); b = mixB(b, ~child);
          c = mixA(c, TEXT_SHAPE_A); d = mixB(d, TEXT_SHAPE_B);
        }
      } else if (Array.isArray(child)) {
        n += child.$n; v += child.$v;
        if (!child.$t) t = false;
        if (withHashes) {
          a = mixA(a, child.$a); b = mixB(b, child.$b);
          c = mixA(c, child.$c); d = mixB(d, child.$d);
        }
      } else {
        n += child.$n;
        t = false;
      }
    }
    node.$n = n; node.$v = v; node.$t = t;
    if (withHashes) {
      const count = node.length;
      node.$a = mixA(a, count); node.$b = mixB(b, count);
      node.$c = mixA(c, count); node.$d = mixB(d, count);
    }
    return node;
  }

  /** Size a shadow root or document object once its children are final. */
  function sealSpecial(special) {
    const children = special.r || special.d || [];
    let n = 1;
    for (let i = 0; i < children.length; i++) n += nodeCount(children[i]);
    special.$n = n;
    special.$t = false;
    return special;
  }

  function nodeCount(node) {
    return typeof node === 'number' ? 1 : node.$n;
  }

  function sameTree(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' || typeof b === 'number') return false;
    if (a.length !== b.length || a[0] !== b[0]) return false;
    const aa = a[1], ba = b[1];
    if (aa !== ba) {
      if (!aa || !ba || aa.length !== ba.length) return false;
      for (let i = 0; i < aa.length; i++) if (aa[i] !== ba[i]) return false;
    }
    for (let i = 2; i < a.length; i++) if (!sameTree(a[i], b[i])) return false;
    return true;
  }

  // Value-slot differences between two trees of the same shape, as a flat
  // [slot, value, ...] list; null when the shapes differ or too much changed.
  function diffValues(template, node) {
    const state = { slot: 0, out: [], limit: Math.max(2, node.$v) };
    return diffWalk(template, node, state) ? state.out : null;
  }
  function diffWalk(a, b, state) {
    if (typeof a === 'number' || typeof b === 'number') {
      if (typeof a !== 'number' || typeof b !== 'number') return false;
      const slot = state.slot++;
      if (a !== b) {
        if (state.out.length >= state.limit) return false;
        state.out.push(slot, b);
      }
      return true;
    }
    if (a === b) { state.slot += a.$v; return true; }
    if (a[0] !== b[0] || a.length !== b.length) return false;
    const aa = a[1], ba = b[1];
    if (!aa !== !ba) return false;
    if (aa) {
      if (aa.length !== ba.length) return false;
      for (let i = 0; i < aa.length; i += 2) {
        if (aa[i] !== ba[i]) return false;
        const slot = state.slot++;
        if (aa[i + 1] !== ba[i + 1]) {
          if (state.out.length >= state.limit) return false;
          state.out.push(slot, ba[i + 1]);
        }
      }
    }
    for (let i = 2; i < a.length; i++) if (!diffWalk(a[i], b[i], state)) return false;
    return true;
  }

  function applyPatches(template, wire) {
    const state = { i: 1, slot: 0, wire };
    return patchClone(template, state);
  }
  function patchClone(node, state) {
    const wire = state.wire;
    if (typeof node === 'number') {
      const slot = state.slot++;
      if (state.i < wire.length && wire[state.i] === slot) {
        const value = wire[state.i + 1];
        state.i += 2;
        return value;
      }
      return node;
    }
    if (state.i >= wire.length || wire[state.i] >= state.slot + node.$v) {
      state.slot += node.$v;
      return node;
    }
    const attrs = node[1];
    let nextAttrs = attrs;
    if (attrs) {
      for (let k = 1; k < attrs.length; k += 2) {
        const slot = state.slot++;
        if (state.i < wire.length && wire[state.i] === slot) {
          if (nextAttrs === attrs) nextAttrs = attrs.slice();
          nextAttrs[k] = wire[state.i + 1];
          state.i += 2;
        }
      }
    }
    const out = [node[0], nextAttrs];
    for (let k = 2; k < node.length; k++) out.push(patchClone(node[k], state));
    out.$n = node.$n; out.$v = node.$v; out.$t = true;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------
  function Templates(recorder) {
    this.list = [];
    this.exact = recorder ? new Map() : null;
    this.shape = recorder ? new Map() : null;
  }
  Templates.prototype.add = function (node) {
    if (this.list.length >= MAX_TEMPLATES) return -1;
    const id = this.list.length;
    this.list.push(node);
    if (this.exact) {
      const key = hashKey(node.$a, node.$b);
      if (!this.exact.has(key)) this.exact.set(key, id);
      this.shape.set(hashKey(node.$c, node.$d), id);
    }
    return id;
  };

  function newEncodeStats() {
    return { refs: 0, ref_nodes: 0, patches: 0, patch_nodes: 0, patch_values: 0, full_nodes: 0 };
  }

  /** Recorder: a sealed tree (with hashes) to its wire form, registering templates. */
  function encodeTree(node, templates, stats) {
    if (typeof node === 'number') return node;
    if (!Array.isArray(node)) {
      const out = {};
      for (const key in node) {
        if (key.charCodeAt(0) === 36) continue; // $
        out[key] = key === 'r' || key === 'd' ? node[key].map((child) => encodeTree(child, templates, stats)) : node[key];
      }
      return out;
    }
    const candidate = node.$t && node.$n >= MIN_TEMPLATE_NODES;
    if (candidate) {
      let id = templates.exact.get(hashKey(node.$a, node.$b));
      if (id !== undefined && sameTree(templates.list[id], node)) {
        if (stats) { stats.refs++; stats.ref_nodes += node.$n; }
        return [-1 - id];
      }
      id = templates.shape.get(hashKey(node.$c, node.$d));
      if (id !== undefined) {
        const patches = diffValues(templates.list[id], node);
        if (patches && patches.length <= node.$v) {
          if (stats) { stats.patches++; stats.patch_nodes += node.$n; stats.patch_values += patches.length >> 1; }
          const out = [-1 - id];
          for (let i = 0; i < patches.length; i++) out.push(patches[i]);
          return out;
        }
      }
    }
    const out = [node[0], node[1] || 0];
    for (let i = 2; i < node.length; i++) out.push(encodeTree(node[i], templates, stats));
    if (stats) stats.full_nodes += 1;
    if (candidate) templates.add(node);
    return out;
  }

  /** Player: wire form back to a sealed tree, registering templates in the same order. */
  function decodeTree(wire, templates) {
    if (typeof wire === 'number') return wire;
    if (!Array.isArray(wire)) {
      const out = {};
      for (const key in wire) {
        out[key] = key === 'r' || key === 'd' ? wire[key].map((child) => decodeTree(child, templates)) : wire[key];
      }
      return sealSpecial(out);
    }
    if (wire[0] < 0) {
      const template = templates.list[-1 - wire[0]];
      if (!template) throw new Error('Session replay: unknown template ' + (-1 - wire[0]));
      return wire.length > 1 ? applyPatches(template, wire) : template;
    }
    const node = [wire[0], wire[1] || 0];
    for (let i = 2; i < wire.length; i++) node.push(decodeTree(wire[i], templates));
    seal(node, false);
    if (node.$t && node.$n >= MIN_TEMPLATE_NODES) templates.add(node);
    return node;
  }

  // ---------------------------------------------------------------------------
  // Pointer paths. Points are a flat [t, x, y, ...] list. The simplification keeps
  // the points that a time-synchronous straight line cannot reproduce within eps
  // pixels (top-down time ratio); the player draws a spline through the rest.
  // ---------------------------------------------------------------------------
  function simplifyPath(points, eps) {
    const count = points.length / 3;
    if (count <= 2) return points.slice();
    const keep = new Uint8Array(count);
    keep[0] = 1; keep[count - 1] = 1;
    const stack = [0, count - 1];
    const eps2 = eps * eps;
    while (stack.length) {
      const last = stack.pop(), first = stack.pop();
      const t0 = points[first * 3], x0 = points[first * 3 + 1], y0 = points[first * 3 + 2];
      const t1 = points[last * 3], x1 = points[last * 3 + 1], y1 = points[last * 3 + 2];
      const span = t1 - t0;
      let worst = -1, worstD = eps2;
      for (let i = first + 1; i < last; i++) {
        const ratio = span > 0 ? (points[i * 3] - t0) / span : 0.5;
        const dx = points[i * 3 + 1] - (x0 + (x1 - x0) * ratio);
        const dy = points[i * 3 + 2] - (y0 + (y1 - y0) * ratio);
        const d = dx * dx + dy * dy;
        if (d > worstD) { worstD = d; worst = i; }
      }
      if (worst >= 0) {
        keep[worst] = 1;
        stack.push(first, worst, worst, last);
      }
    }
    const out = [];
    for (let i = 0; i < count; i++) if (keep[i]) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    return out;
  }

  /** Centripetal-free uniform Catmull-Rom position at time t over a flat [t,x,y] track. */
  function pathPosition(track, t) {
    const count = track.length / 3;
    if (!count) return null;
    if (t <= track[0]) return [track[1], track[2]];
    if (t >= track[(count - 1) * 3]) return [track[(count - 1) * 3 + 1], track[(count - 1) * 3 + 2]];
    let lo = 0, hi = count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid * 3] <= t) lo = mid; else hi = mid;
    }
    const i1 = lo, i2 = hi, i0 = Math.max(0, i1 - 1), i3 = Math.min(count - 1, i2 + 1);
    const ta = track[i1 * 3], tb = track[i2 * 3];
    const u = tb > ta ? (t - ta) / (tb - ta) : 1;
    const u2 = u * u, u3 = u2 * u;
    const at = (k, axis) => track[k * 3 + axis];
    const point = (axis) => 0.5 * ((2 * at(i1, axis)) + (-at(i0, axis) + at(i2, axis)) * u
      + (2 * at(i0, axis) - 5 * at(i1, axis) + 4 * at(i2, axis) - at(i3, axis)) * u2
      + (-at(i0, axis) + 3 * at(i1, axis) - 3 * at(i2, axis) + at(i3, axis)) * u3);
    return [point(1), point(2)];
  }

  // Splice form of a text change: [at, deleteCount, inserted] or null when equal.
  function textSplice(before, after) {
    if (before === after) return null;
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    let endB = before.length, endA = after.length;
    while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) { endB--; endA--; }
    return [start, endB - start, after.slice(start, endA)];
  }

  return {
    FORMAT, MIN_TEMPLATE_NODES, MAX_TEMPLATES, BLOB_MIN_CHARS, BLOB_PREFIX, E, PTR, DIAG_FIELDS,
    blobKey, isBlobRef, seal, sealSpecial, nodeCount, sameTree, diffValues, applyPatches,
    Templates, newEncodeStats, encodeTree, decodeTree, simplifyPath, pathPosition, textSplice, hashKey
  };
});
