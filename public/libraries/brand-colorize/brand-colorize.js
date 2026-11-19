/* public/libraries/brand-colorize/brand-colorize.js
 *
 * Recolours a page we cannot style (Forward's merchant portal, cross-origin in an iframe) from the one colour it is
 * drawn in to the organization's brand colour (GP-77). Its pixels cannot be read or restyled from here, so the only
 * tool is a filter on the iframe element. CSS hue-rotate/saturate keep greys but also keep the colour's luminance (a
 * dark teal can only become a dark yellow), and brightness/contrast change greys and white. Instead this builds one
 * SVG colour matrix (feColorMatrix, in sRGB) that:
 *   - leaves every grey, white and black exactly as it is (each row sums to 1),
 *   - maps the base colour exactly onto the target, and so every tint or shade of it (the base mixed with white,
 *     black or a grey) onto the same mix of the target: a 12% teal hover background becomes a 12% brand tint.
 * In "family" mode (the default) only colours leaning towards the base's hue are recoloured, blended in by how far
 * they lean, so colours on the other side of the wheel (a red error, an amber warning when the base is teal) keep
 * theirs. "all" mode recolours every colour (hue turned and scaled like the base).
 *
 * window.FirstMateBrandColorize:
 *   FORWARD_BASE                      Forward's portal colour (#007a76, measured from the portal).
 *   matrix(base, target)              3x3 sRGB matrix (rows) mapping base -> target, greys fixed.
 *   filterMarkup(id, base, target, { mode })  an SVG <filter> element as markup.
 *   filterFor(target, { base, mode }) defines the filter once in this document; returns 'url(#id)' for CSS `filter`.
 *   brandColor()                      the organization's colour as the portal draws text on white (--primary-readable).
 *   readableOnWhite(hex)              the portal's own readable-on-white rule (portal/index.php applyTheme).
 *   attach(frame, options)            keeps frame.style.filter on the brand colour (or the dev preview); returns detach.
 *   preview(hex | null, { mode })     development: every attached frame shows this colour instead (the dev console).
 */
(function (root) {
  'use strict';

  const FORWARD_BASE = '#007a76';
  const MODES = ['family', 'all'];
  // A tint at least this strong (share of the base mixed into white) is fully recoloured in family mode.
  const FAMILY_FULL_TINT = 0.06;

  function parseColor(value) {
    const text = String(value ?? '').trim().toLowerCase();
    let match = text.match(/^#?([0-9a-f]{3})$/);
    if (match) return match[1].split('').map((c) => parseInt(c + c, 16) / 255);
    match = text.match(/^#?([0-9a-f]{6})$/);
    if (match) return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255);
    match = text.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/);
    if (match) return match.slice(1, 4).map((n) => Math.min(255, Number(n)) / 255);
    return null;
  }
  function toHex(rgb) {
    return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const mean = (v) => (v[0] + v[1] + v[2]) / 3;

  /*
   * M = N + R + Δμ·n·cbᵀ/|cb|², with n = (1,1,1), N the projection onto n, cb and ct the base's and target's
   * chroma (colour minus its mean grey), R the turn-and-scale in the chroma plane taking cb to ct, and Δμ the change
   * in mean. M·n = n, so greys stay; M·base = target.
   */
  function matrix(base, target) {
    const b = Array.isArray(base) ? base : parseColor(base);
    const t = Array.isArray(target) ? target : parseColor(target);
    const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    if (!b || !t) return identity;
    const mb = mean(b), mt = mean(t);
    const cb = b.map((v) => v - mb), ct = t.map((v) => v - mt);
    const cb2 = dot(cb, cb);
    // A grey base has no colour to move.
    if (cb2 < 1e-6) return identity;
    const len = Math.sqrt(cb2);
    const e1 = cb.map((v) => v / len);
    const s3 = 1 / Math.sqrt(3);
    const nh = [s3, s3, s3];
    const e2 = [nh[1] * e1[2] - nh[2] * e1[1], nh[2] * e1[0] - nh[0] * e1[2], nh[0] * e1[1] - nh[1] * e1[0]];
    const cosPart = dot(ct, e1) / len, sinPart = dot(ct, e2) / len;
    // K·x = n̂ × x
    const K = [[0, -nh[2], nh[1]], [nh[2], 0, -nh[0]], [-nh[1], nh[0], 0]];
    const dm = mt - mb;
    const m = [];
    for (let i = 0; i < 3; i += 1) {
      m.push([]);
      for (let j = 0; j < 3; j += 1) {
        const n = 1 / 3;
        const P = (i === j ? 1 : 0) - n;
        m[i].push(n + cosPart * P + sinPart * K[i][j] + dm * cb[j] / cb2);
      }
    }
    return m;
  }
  function apply(m, rgb) {
    return m.map((row) => Math.min(1, Math.max(0, dot(row, rgb))));
  }

  const fmt = (n) => (Math.abs(n) < 1e-9 ? '0' : String(Math.round(n * 1e6) / 1e6));
  function filterMarkup(id, base, target, options = {}) {
    const mode = MODES.includes(options.mode) ? options.mode : 'family';
    const m = matrix(base, target);
    const values = `${m.map((row) => `${row.map(fmt).join(' ')} 0 0`).join(' ')} 0 0 0 1 0`;
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '');
    if (mode === 'all') {
      return `<filter id="${safeId}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%"><feColorMatrix type="matrix" values="${values}"/></filter>`;
    }
    // Family: alpha = gain·(how far the pixel leans towards the base's hue), clamped to 0..1 by the filter; the
    // recoloured pixel is laid over the original by that alpha.
    const b = parseColor(base) || [0, 0, 0];
    const mb = mean(b);
    const cb = b.map((v) => v - mb);
    const len = Math.sqrt(dot(cb, cb)) || 1;
    const gain = 1 / (FAMILY_FULL_TINT * len);
    const lean = cb.map((v) => fmt((v / len) * gain)).join(' ');
    return `<filter id="${safeId}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">`
      + `<feColorMatrix in="SourceGraphic" type="matrix" values="${values}" result="recolored"/>`
      + `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${lean} 0 0" result="lean"/>`
      + `<feComposite in="recolored" in2="lean" operator="in" result="family"/>`
      + `<feComposite in="family" in2="SourceGraphic" operator="over"/>`
      + `</filter>`;
  }

  // ---- In the page ------------------------------------------------------------------------------------------------

  const doc = () => root.document;
  let defs = null;
  const defined = new Set();
  function filterFor(target, options = {}) {
    const base = toHex(parseColor(options.base || FORWARD_BASE) || parseColor(FORWARD_BASE));
    const rgb = parseColor(target);
    const mode = MODES.includes(options.mode) ? options.mode : 'family';
    if (!rgb || !doc()) return '';
    const hex = toHex(rgb);
    const id = `fm-brand-colorize-${base.slice(1)}-${hex.slice(1)}-${mode}`;
    if (!defined.has(id) || !defs?.isConnected || !doc().getElementById(id)) {
      if (!defs?.isConnected) {
        defs = doc().createElementNS('http://www.w3.org/2000/svg', 'svg');
        defs.setAttribute('aria-hidden', 'true');
        defs.setAttribute('data-fm-brand-colorize', '');
        defs.setAttribute('data-fmr-ignore', '');
        defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
        (doc().body || doc().documentElement).appendChild(defs);
        defined.clear();
      }
      defs.insertAdjacentHTML('beforeend', filterMarkup(id, base, hex, { mode }));
      defined.add(id);
    }
    return `url(#${id})`;
  }

  function relativeLuminance(rgb) {
    const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }
  // Same rule as applyTheme's readableOnWhite in portal/index.php, which sets --primary-readable.
  function readableOnWhite(hex) {
    const rgb = parseColor(hex);
    if (!rgb) return '';
    const ratio = (c) => 1.05 / (relativeLuminance(c.map((v) => v / 255)) + 0.05);
    let c = rgb.map((v) => Math.round(v * 255));
    if (ratio(c) >= 3.5) return toHex(rgb);
    for (let i = 0; i < 20; i += 1) {
      c = c.map((v) => Math.max(0, Math.round(v * 0.85)));
      if (ratio(c) >= 3.5) break;
    }
    return toHex(c.map((v) => v / 255));
  }
  function brandColor() {
    const d = doc();
    if (!d) return '';
    const style = root.getComputedStyle?.(d.documentElement);
    const readable = parseColor(style?.getPropertyValue('--primary-readable'));
    if (readable) return toHex(readable);
    const primary = parseColor(style?.getPropertyValue('--primary')) || parseColor(root.Portal?.currentTheme?.primary);
    return primary ? readableOnWhite(toHex(primary)) : '';
  }

  const frames = new Set();
  let previewState = null;
  function paint(entry) {
    if (!entry.frame.isConnected) { frames.delete(entry); return; }
    const target = previewState?.color || brandColor();
    const filter = target ? filterFor(target, { base: entry.base, mode: previewState?.mode || entry.mode }) : '';
    entry.frame.style.filter = filter || '';
    entry.frame.dataset.fmBrandColorize = target ? toHex(parseColor(target)) : '';
  }
  function repaint() { frames.forEach(paint); }
  function attach(frame, options = {}) {
    if (!frame) return () => {};
    const entry = { frame, base: options.base || FORWARD_BASE, mode: options.mode };
    frames.add(entry);
    paint(entry);
    return () => { frames.delete(entry); };
  }
  function preview(color, options = {}) {
    const rgb = color ? parseColor(color) : null;
    previewState = rgb ? { color: toHex(rgb), mode: MODES.includes(options.mode) ? options.mode : 'family' } : null;
    repaint();
    root.dispatchEvent?.(new root.CustomEvent('fm:brand-colorize-preview', { detail: previewState }));
    return previewState;
  }

  const api = {
    version: '20261119-gp77',
    FORWARD_BASE, MODES,
    parseColor, toHex, matrix, apply, filterMarkup, filterFor,
    readableOnWhite, brandColor, attach, preview,
    previewing: () => previewState,
    frames: () => [...frames].filter((entry) => entry.frame.isConnected).map((entry) => entry.frame)
  };
  if (root.addEventListener) {
    // The portal sets --primary-readable after announcing the theme; read it once that has happened.
    root.addEventListener('fm:theme:updated', () => root.setTimeout(repaint, 0));
  }
  if (root.FirstMateBrandColorize?.version !== api.version) root.FirstMateBrandColorize = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
