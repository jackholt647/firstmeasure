/* public/libraries/dev-console/dock.js
 *
 * Docking (docs/architecture/dev-console.md, "Docking"): while the dev console is on a desktop page, the page behaves
 * as a window narrower by the console's width, like Chrome's docked devtools, instead of being covered.
 *
 * - <body> becomes the containing block for fixed layers (dev-console.css: fixed to the remaining width, layout
 *   containment), so the page, its modals, trays, toasts, overlays and the project window all end at the console.
 *   The console itself is mounted on <html>, outside it.
 * - Stylesheets: width media queries are shifted by the console's width, and vw lengths are rewritten to the
 *   remaining width (--fm-dc-vw), in every stylesheet the page can read, including ones added later.
 * - Script: window.innerWidth, document.documentElement.clientWidth and matchMedia() width queries answer for the
 *   remaining width, and a resize event fires on every change.
 * - The top layer (modal dialogs, popovers) ignores containing blocks; modal dialogs and their backdrops are kept
 *   clear of the console by dev-console.css.
 *
 * The page keeps its own document: no frame, nothing changes for window.top, history or the realtime stream.
 * Phones are not docked. A page whose document itself scrolls (the portal does not) scrolls inside <body> while
 * docked, and its fixed layers scroll with it.
 */
const VW = /(-?(?:\d+\.?\d*|\.\d+))[dsl]?vw\b/gi;
const HAS_VW = /\d[dsl]?vw\b/i;
const WIDTH_FEATURE = /\(\s*(min-width|max-width)\s*:\s*([^()]+(?:\([^()]*\)[^()]*)*)\)/gi;
const RANGE_AFTER = /\bwidth\s*(<=|>=|<|>|=)\s*((?:calc\([^()]*(?:\([^()]*\)[^()]*)*\))|-?[\d.]+[a-z%]*)/gi;
const RANGE_BEFORE = /((?:calc\([^()]*(?:\([^()]*\)[^()]*)*\))|-?[\d.]+[a-z%]*)\s*(<=|>=|<|>|=)\s*width\b/gi;

let width = 0;
const tracked = new Set();            // { list: MediaList, original: string }
const processed = new WeakSet();      // style sheets already read
const queries = new Set();            // WeakRef<DockedQuery>
let realMatchMedia = null, realMatches = null, realInnerWidth = null, realClientWidth = null, installed = false, queued = 0;

/** A media query for a viewport `shift` px wider: what the page's query means at the remaining width. */
export function shiftMediaQuery(text, shift) {
  if (!shift || !/width/i.test(text)) return text;
  const plus = (value) => `calc(${value.trim()} + ${shift}px)`;
  return String(text)
    .replace(WIDTH_FEATURE, (_m, feature, value) => `(${feature}: ${plus(value)})`)
    .replace(RANGE_AFTER, (m, op, value) => /device-width/i.test(m) ? m : `width ${op} ${plus(value)}`)
    .replace(RANGE_BEFORE, (m, value, op) => `${plus(value)} ${op} width`);
}
/** A declaration value with every vw length measured against the remaining width. */
export function rewriteVw(value) {
  return String(value).replace(VW, (_m, number) => `calc(${number} * var(--fm-dc-vw))`);
}

function track(list) {
  if (!list || !/width/i.test(list.mediaText)) return;
  const entry = { list, original: list.mediaText };
  tracked.add(entry);
  try { list.mediaText = shiftMediaQuery(entry.original, width); } catch (_) {}
}
function walk(rules) {
  for (const rule of rules) {
    if (rule.media && rule.type !== CSSRule.STYLE_RULE) track(rule.media);
    const style = rule.style;
    if (style) {
      for (let i = 0; i < style.length; i++) {
        const name = style[i], value = style.getPropertyValue(name);
        if (HAS_VW.test(value)) style.setProperty(name, rewriteVw(value), style.getPropertyPriority(name));
      }
    }
    if (rule.cssRules) walk(rule.cssRules);
    if (rule.styleSheet) readSheet(rule.styleSheet);
  }
}
function readSheet(sheet) {
  if (!sheet || processed.has(sheet)) return;
  // The console's own stylesheet defines the remaining width; it is not part of the page.
  if (sheet.ownerNode?.hasAttribute?.('data-fm-dc')) { processed.add(sheet); return; }
  let rules;
  try { rules = sheet.cssRules; } catch (_) { return; } // another origin, or still loading
  processed.add(sheet);
  if (sheet.media) track(sheet.media);
  walk(rules);
}
function readAll() {
  queued = 0;
  for (const sheet of document.styleSheets) readSheet(sheet);
  for (const sheet of document.adoptedStyleSheets || []) readSheet(sheet);
}
const soon = () => { if (!queued) queued = requestAnimationFrame(readAll); };

/** matchMedia() for width queries: answers for the remaining width and reports changes when the console resizes. */
class DockedQuery extends EventTarget {
  constructor(media) {
    super();
    this.media = media;
    this.onchange = null;
    this.last = this.matches;
    queries.add(new WeakRef(this));
  }
  get matches() { return realMatches.call(realMatchMedia(shiftMediaQuery(this.media, width))); }
  addListener(fn) { if (fn) this.addEventListener('change', fn); }
  removeListener(fn) { if (fn) this.removeEventListener('change', fn); }
  check() {
    const now = this.matches;
    if (now === this.last) return;
    this.last = now;
    const event = typeof MediaQueryListEvent === 'function' ? new MediaQueryListEvent('change', { matches: now, media: this.media }) : Object.assign(new Event('change'), { matches: now, media: this.media });
    this.dispatchEvent(event);
    try { this.onchange?.(event); } catch (error) { setTimeout(() => { throw error; }); }
  }
}
function checkQueries() {
  for (const ref of queries) { const query = ref.deref(); if (query) query.check(); else queries.delete(ref); }
}

function install() {
  if (installed) return;
  installed = true;
  const root = document.documentElement;
  // Defined before any vw is rewritten to use it.
  root.style.setProperty('--fm-dc-width', '0px');
  root.style.setProperty('--fm-dc-vw', 'calc((100vw - var(--fm-dc-width, 0px)) / 100)');
  // A page whose document scrolls keeps scrolling, inside <body>, where it was.
  if (getComputedStyle(document.body).overflowY === 'visible') {
    const y = window.scrollY;
    root.classList.add('fm-dc-body-scrolls');
    requestAnimationFrame(() => { document.body.scrollTop = y; });
  }
  realMatchMedia = window.matchMedia.bind(window);
  const widthQuery = (query) => /width/i.test(String(query)) && !/device-width/i.test(String(query));
  window.matchMedia = (query) => widthQuery(query) ? new DockedQuery(String(query)) : realMatchMedia(query);
  // Lists the page made before the console loaded answer for the remaining width too (their change events still
  // follow the real window).
  const matches = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, 'matches');
  realMatches = matches.get;
  Object.defineProperty(MediaQueryList.prototype, 'matches', { configurable: true, enumerable: true, get() {
    return width && widthQuery(this.media) ? realMatches.call(realMatchMedia(shiftMediaQuery(this.media, width))) : realMatches.call(this);
  } });
  const inner = Object.getOwnPropertyDescriptor(window, 'innerWidth') || Object.getOwnPropertyDescriptor(Window.prototype, 'innerWidth');
  realInnerWidth = () => inner?.get ? inner.get.call(window) : document.documentElement.getBoundingClientRect().width;
  Object.defineProperty(window, 'innerWidth', { configurable: true, enumerable: true, get: () => Math.max(0, realInnerWidth() - width), set() {} });
  const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  realClientWidth = (el) => client.get.call(el);
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get() { return Math.max(0, realClientWidth(this) - width); } });
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('load', (event) => { if (event.target?.matches?.('link[rel~="stylesheet"]')) soon(); }, true);
  window.addEventListener('resize', (event) => { if (!event.fmDock) checkQueries(); });
  readAll();
}

/** The real width of the window, whatever the page is told. */
export function windowWidth() { return realInnerWidth ? realInnerWidth() : window.innerWidth; }

/** Docks the page beside a console `px` wide (0: not docked). */
export function dock(px) {
  const next = Math.max(0, Math.round(px));
  if (next) install();
  if (next === width) return;
  width = next;
  const root = document.documentElement;
  root.classList.toggle('fm-dc-docked', width > 0);
  root.style.setProperty('--fm-dc-width', width + 'px');
  for (const entry of tracked) {
    if (!entry.list.parentStyleSheet && !entry.list.mediaText) { tracked.delete(entry); continue; }
    try { entry.list.mediaText = shiftMediaQuery(entry.original, width); } catch (_) { tracked.delete(entry); }
  }
  checkQueries();
  const event = new Event('resize'); event.fmDock = true;
  window.dispatchEvent(event);
}
