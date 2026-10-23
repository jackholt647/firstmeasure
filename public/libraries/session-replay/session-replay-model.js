/* libraries/session-replay/session-replay-model.js
 * A recording rebuilt without a browser: the same events the player applies, applied
 * to plain objects. Used by the server to index recordings for search, and usable in a
 * page. Needs session-replay-codec.js. See docs/architecture/session-replay-search.md.
 *
 *   const page = FMReplayModel.readPage(chunks);   // chunks: parsed chunk objects of one page, in order
 *   for (const step of page.steps()) { step.event; step.mirror.describe(id); }
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./session-replay-codec.js') : root.FMReplayCodec);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FMReplayModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Codec) {
  'use strict';
  const { E } = Codec;
  const TEXT = '#text', DOC = '#document', SHADOW = '#shadow';

  /** A node: { id, tag, attrs (object), children, parent, text, value } */
  class VirtualMirror {
    constructor(strings, blobs) {
      this.strings = strings;
      this.blobs = blobs || null;
      this.nodes = new Map();
      this.root = null;
      this.values = new Map();
      this.focusId = 0;
      this.hoverId = 0;
      this.url = '';
    }

    text(id) {
      const value = this.strings[id];
      if (value === undefined) return '';
      if (Codec.isBlobRef(value)) {
        if (!this.blobs) return '';
        const blob = this.blobs.get(value.slice(Codec.BLOB_PREFIX.length));
        return blob === undefined ? '' : blob;
      }
      return value;
    }

    build(node, ref, parent) {
      if (typeof node === 'number') {
        const v = { id: ref.v++, tag: TEXT, attrs: null, children: null, parent, text: this.text(node) };
        this.nodes.set(v.id, v);
        return v;
      }
      if (!Array.isArray(node)) {
        const v = { id: ref.v++, tag: node.r ? SHADOW : DOC, attrs: null, children: [], parent, text: '' };
        if (node.u !== undefined && node.u >= 0) v.url = this.text(node.u);
        this.nodes.set(v.id, v);
        for (const child of node.r || node.d) v.children.push(this.build(child, ref, v));
        return v;
      }
      const v = { id: ref.v++, tag: this.text(node[0]), attrs: {}, children: [], parent, text: '' };
      this.nodes.set(v.id, v);
      const attrs = node[1];
      if (attrs) {
        for (let i = 0; i < attrs.length; i += 2) {
          const name = this.text(attrs[i]);
          if (name === '__css') continue; // stylesheet text says nothing about behaviour
          const value = this.text(attrs[i + 1]);
          if (name === '__value' || name === '__checked') this.values.set(v.id, value);
          else v.attrs[name] = value;
        }
      }
      for (let i = 2; i < node.length; i++) v.children.push(this.build(node[i], ref, v));
      return v;
    }

    forget(v) {
      if (this.nodes.get(v.id) === v) this.nodes.delete(v.id);
      this.values.delete(v.id);
      if (v.children) for (const child of v.children) this.forget(child);
    }

    detach(v) {
      const parent = v.parent;
      if (!parent) return;
      const index = parent.children.indexOf(v);
      if (index >= 0) parent.children.splice(index, 1);
      v.parent = null;
    }

    /** Applies one decoded event; returns what it changed, for indexing. */
    apply(type, a) {
      switch (type) {
        case E.SNAPSHOT: {
          this.nodes.clear();
          this.values.clear();
          this.root = this.build(a[1], { v: a[0] }, null);
          if (this.root.url) this.url = this.root.url;
          return null;
        }
        case E.MUT: return this.mutate(a);
        case E.FRAME: {
          const frame = this.nodes.get(a[0]);
          if (!frame) return null;
          for (const child of frame.children.splice(0)) this.forget(child);
          frame.children.push(this.build(a[2], { v: a[1] }, frame));
          return { added: [frame.children[0]] };
        }
        case E.SHADOW: {
          const host = this.nodes.get(a[0]);
          if (!host) return null;
          const shadow = this.build(a[2], { v: a[1] }, host);
          host.children.unshift(shadow);
          return { added: [shadow] };
        }
        case E.INPUT: {
          const before = this.values.get(a[0]) || '';
          if (a[1] === 1) this.values.set(a[0], a[2] ? '1' : '0');
          else if (a[1] === 2) this.values.set(a[0], before.slice(0, a[2]) + this.text(a[4]) + before.slice(a[2] + a[3]));
          else this.values.set(a[0], this.text(a[2]));
          return null;
        }
        case E.FOCUS: this.focusId = a[0]; return null;
        case E.HOVER: this.hoverId = a[0]; return null;
        case E.NAV: this.url = this.text(a[0]); return null;
        default: return null;
      }
    }

    mutate(a) {
      const removes = a[0], adds = a[1], attrs = a[2], texts = a[3];
      const out = { removed: [], added: [], attrs: [], texts: [] };
      if (removes) {
        for (const id of removes) {
          const v = this.nodes.get(id);
          if (!v) continue;
          out.removed.push(v);
          this.detach(v);
          this.forget(v);
        }
      }
      if (adds) {
        for (let i = 0; i < adds.length; i += 4) {
          const parent = this.nodes.get(adds[i]);
          if (!parent || !parent.children) continue;
          const next = adds[i + 1] ? this.nodes.get(adds[i + 1]) : null;
          const v = this.build(adds[i + 3], { v: adds[i + 2] }, parent);
          const index = next ? parent.children.indexOf(next) : -1;
          if (index >= 0) parent.children.splice(index, 0, v); else parent.children.push(v);
          out.added.push(v);
        }
      }
      if (attrs) {
        for (let i = 0; i < attrs.length; i += 3) {
          const v = this.nodes.get(attrs[i]);
          if (!v || !v.attrs) continue;
          const name = this.text(attrs[i + 1]);
          if (name === '__css') continue;
          if (attrs[i + 2] === -1) delete v.attrs[name];
          else if (name === '__value' || name === '__checked') this.values.set(v.id, this.text(attrs[i + 2]));
          else v.attrs[name] = this.text(attrs[i + 2]);
          out.attrs.push([v, name]);
        }
      }
      if (texts) {
        for (let i = 0; i < texts.length; i += 2) {
          const v = this.nodes.get(texts[i]);
          if (!v) continue;
          v.text = this.text(texts[i + 1]);
          out.texts.push(v);
        }
      }
      return out;
    }

    // ---- reading ------------------------------------------------------------------
    node(id) { return this.nodes.get(id) || null; }

    ancestors(v) {
      const out = [];
      for (let n = v && v.parent; n; n = n.parent) if (n.tag !== TEXT) out.push(n);
      return out;
    }

    /** Visible-ish text of a subtree, bounded. Skips style/script and hidden elements. */
    textOf(v, max = 200) {
      let out = '';
      const walk = (n) => {
        if (out.length >= max || !n) return;
        if (n.tag === TEXT) { out += n.text; return; }
        if (n.tag === 'style' || n.tag === 'script' || n.tag === 'noscript' || n.tag === 'template') return;
        if (n.attrs && (n.attrs.hidden !== undefined || n.attrs['aria-hidden'] === 'true')) return;
        if (n.children) for (const child of n.children) walk(child);
      };
      walk(v);
      return out.replace(/\s+/g, ' ').trim().slice(0, max);
    }

    /** What a person would call this element: its accessible name, roughly. */
    label(v) {
      if (!v) return '';
      if (v.tag === TEXT) v = v.parent;
      const attrs = v.attrs || {};
      const named = attrs['aria-label'] || attrs.title || attrs.alt || attrs.placeholder || '';
      if (named) return named.trim().slice(0, 120);
      if (attrs['aria-labelledby']) {
        const labelled = attrs['aria-labelledby'].split(/\s+/).map((ref) => this.byDomId(ref)).filter(Boolean).map((n) => this.textOf(n, 80)).join(' ');
        if (labelled) return labelled.slice(0, 120);
      }
      if (/^(input|select|textarea)$/.test(v.tag)) {
        // A field is named by its <label for=id>, or by the label it sits in.
        if (attrs.id) {
          for (const n of this.nodes.values()) if (n.tag === 'label' && n.attrs && n.attrs.for === attrs.id) return this.textOf(n, 120);
        }
        for (const n of this.ancestors(v)) if (n.tag === 'label') return this.textOf(n, 120);
        return attrs.name || attrs.type || v.tag;
      }
      return this.textOf(v, 120);
    }

    byDomId(domId) {
      for (const v of this.nodes.values()) if (v.attrs && v.attrs.id === domId) return v;
      return null;
    }

    /** The interactive element a click on v lands on (button, link, input, role=...). */
    interactive(v) {
      for (let n = v; n; n = n.parent) {
        if (n.tag === TEXT || !n.attrs) continue;
        const role = n.attrs.role || '';
        if (/^(a|button|input|select|textarea|summary|option|label)$/.test(n.tag) || /^(button|link|tab|menuitem|option|checkbox|radio|switch|combobox|treeitem|row|gridcell)$/.test(role)
          || n.attrs.onclick !== undefined || n.attrs.tabindex === '0') return n;
      }
      return v && v.tag !== TEXT ? v : (v && v.parent) || null;
    }

    role(v) {
      if (!v || !v.attrs) return '';
      if (v.attrs.role) return v.attrs.role;
      if (v.tag === 'a') return 'link';
      if (v.tag === 'input') return (v.attrs.type || 'text') === 'checkbox' ? 'checkbox' : (v.attrs.type || 'text') === 'radio' ? 'radio' : /^(button|submit|reset)$/.test(v.attrs.type || '') ? 'button' : 'textbox';
      if (/^(button|select|textarea|summary|option)$/.test(v.tag)) return v.tag === 'textarea' ? 'textbox' : v.tag === 'select' ? 'combobox' : v.tag;
      return v.tag;
    }

    /** A selector-ish path of up to four levels: tag#id.class.class, stopping at an id. */
    path(v) {
      const parts = [];
      for (let n = v, depth = 0; n && depth < 4; n = n.parent) {
        if (n.tag === TEXT || n.tag === DOC || n.tag === SHADOW || !n.attrs) continue;
        let part = n.tag;
        if (n.attrs.id) part += '#' + n.attrs.id;
        const classes = (n.attrs.class || '').split(/\s+/).filter((c) => c && !c.startsWith('__fmr-')).slice(0, 2);
        if (classes.length) part += '.' + classes.join('.');
        parts.unshift(part);
        depth++;
        if (n.attrs.id) break;
      }
      return parts.join(' > ');
    }

    /** Headings and landmarks above v: where on the page it sits. */
    context(v, max = 4) {
      const out = [];
      for (const n of this.ancestors(v)) {
        if (out.length >= max) break;
        const attrs = n.attrs || {};
        if (attrs['aria-label'] && /^(dialog|navigation|region|tabpanel|menu|form|main|complementary)$/.test(attrs.role || n.tag)) out.push((attrs.role || n.tag) + ': ' + attrs['aria-label']);
        else if (n.tag === 'dialog' || attrs.role === 'dialog' || attrs['aria-modal'] === 'true') out.push('dialog: ' + this.headingIn(n));
        else if (n.tag === 'form') out.push('form' + (attrs.name ? ': ' + attrs.name : attrs.id ? ': ' + attrs.id : ''));
      }
      return out;
    }

    headingIn(v) {
      let found = '';
      const walk = (n) => {
        if (found || !n || !n.children) return;
        for (const child of n.children) {
          if (found) return;
          if (child.attrs && /^h[1-4]$/.test(child.tag)) { found = this.textOf(child, 80); return; }
          walk(child);
        }
      };
      walk(v);
      return found;
    }

    /** Text of headings h1-h3 on the page (first few), for page identity. */
    headings(limit = 6) {
      const out = [];
      const walk = (n) => {
        if (out.length >= limit || !n || !n.children) return;
        for (const child of n.children) {
          if (out.length >= limit) return;
          if (child.attrs && /^h[1-3]$/.test(child.tag)) { const t = this.textOf(child, 80); if (t) out.push(t); continue; }
          if (child.children) walk(child);
        }
      };
      walk(this.root);
      return out;
    }

    /** Selected tabs (role=tab aria-selected=true, or class active/selected on nav items). */
    activeTabs(limit = 6) {
      const out = [];
      for (const v of this.nodes.values()) {
        if (out.length >= limit || !v.attrs) continue;
        const a = v.attrs;
        if ((a.role === 'tab' && a['aria-selected'] === 'true') || a['aria-current'] === 'page' || a['aria-current'] === 'true') {
          const t = this.label(v);
          if (t) out.push(t);
        }
      }
      return out;
    }

    /** An indented outline of what is on screen, for a reader: tags with roles, labels and text. */
    outline(maxLines = 120, start) {
      const lines = [];
      const walk = (n, depth) => {
        if (lines.length >= maxLines || !n) return;
        if (n.tag === TEXT) { const t = n.text.replace(/\s+/g, ' ').trim(); if (t) lines.push('  '.repeat(depth) + '"' + t.slice(0, 100) + '"'); return; }
        if (n.tag === 'style' || n.tag === 'script' || n.tag === 'head' || n.tag === 'svg' || n.tag === 'noscript' || n.tag === 'template') return;
        if (n.attrs && (n.attrs.hidden !== undefined || n.attrs['aria-hidden'] === 'true' || /display:\s*none/.test(n.attrs.style || ''))) return;
        const attrs = n.attrs || {};
        const role = this.role(n);
        const interesting = /^(button|link|textbox|checkbox|radio|combobox|tab|menuitem|option|switch|dialog|h1|h2|h3|h4|img|table|form)$/.test(role) || attrs['aria-label'];
        let nextDepth = depth;
        if (interesting && n.tag !== DOC && n.tag !== SHADOW) {
          const value = this.values.get(n.id);
          lines.push('  '.repeat(depth) + '[' + role + (attrs.id ? ' #' + attrs.id : '') + ']' + (this.label(n) ? ' ' + this.label(n).slice(0, 80) : '') + (value ? ' = ' + JSON.stringify(value.slice(0, 40)) : '') + ' {' + n.id + '}');
          nextDepth = depth + 1;
          if (/^(button|link|tab|menuitem|option|h1|h2|h3|h4)$/.test(role)) return;
        }
        if (n.children) for (const child of n.children) walk(child, nextDepth);
      };
      walk(start ? this.nodes.get(start) : this.root, 0);
      return lines.join('\n');
    }
  }

  /** Reads one page's chunks (parsed objects, in sequence order) into a step-by-step walk. */
  function readPage(chunks, blobs) {
    const strings = [];
    const templates = new Codec.Templates(false);
    const events = [];
    const cursor = [];
    for (const chunk of chunks) {
      for (const s of chunk.s) strings.push(s);
      let t = chunk.t;
      for (const raw of chunk.e) {
        t += raw[0];
        const type = raw[1];
        const a = raw.slice(2);
        if (type === E.SNAPSHOT) a[1] = Codec.decodeTree(a[1], templates);
        else if (type === E.MUT && a[1]) { for (let k = 3; k < a[1].length; k += 4) a[1][k] = Codec.decodeTree(a[1][k], templates); }
        else if (type === E.FRAME || type === E.SHADOW) a[2] = Codec.decodeTree(a[2], templates);
        events.push({ t, type, a });
      }
      let mt = chunk.t, mx = 0, my = 0;
      const m = chunk.m || [];
      for (let i = 0; i < m.length; i += 3) { mt += m[i]; mx += m[i + 1]; my += m[i + 2]; cursor.push(mt, mx, my); }
    }
    const meta = (() => { const first = events.find((e) => e.type === E.META); try { return first ? JSON.parse(strings[first.a[0]]) : {}; } catch (error) { return {}; } })();
    return {
      strings, events, cursor, meta,
      text: (id) => { const v = strings[id]; return v === undefined ? '' : v; },
      /** Walks the events with a mirror kept up to date; the callback sees the mirror before and after each event. */
      walk(visit) {
        const mirror = new VirtualMirror(strings, blobs);
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (visit.before) visit.before(event, mirror, i);
          const change = mirror.apply(event.type, event.a);
          if (visit.after) visit.after(event, mirror, change, i);
        }
        return mirror;
      },
      /** The mirror as it stood at time t. */
      mirrorAt(t) {
        const mirror = new VirtualMirror(strings, blobs);
        for (const event of events) { if (event.t > t) break; mirror.apply(event.type, event.a); }
        return mirror;
      }
    };
  }

  return { VirtualMirror, readPage };
});
