/* libraries/live-assets/live-assets.js
 * Applies the live layer to an open page on dev.1m8.ai (docs/architecture/live-layer.md).
 *
 * PlatformRealtime watches `live-assets` on the page's one stream and hands each frame here:
 *   hello   { gen, files: { path: sha } }        the files the layer serves now
 *   changed { gen, files: [{ path, sha|null }] } files written, or gone back to the release (sha null)
 *   release { release }                          the host switched to another platform release
 *
 * A page remembers the release it was loaded on (`release` in its first hello) and reloads onto a newer one
 * at the first quiet moment (createReleaseWatch): visible, nobody typing in a field, no touch or key for a few
 * seconds. Open dev pages, the Android development app's among them, so run what was just shipped.
 *
 * For every frame of this page (the page and its same-origin frames that have no receiver of their own):
 * a changed stylesheet <link> or <img> is swapped in place, and so is a script's injected <style> when the
 * edit touched only that CSS (swapInlineStyle); anything else the frame loaded (script logic, modules, JSON)
 * reloads that frame only, after the browser's cached copies of those URLs are refetched so the reload cannot
 * run an old copy. Files a frame never loaded are left alone.
 */

// Hashed with line endings folded, as the receiver and tools/frontend-bridge do.
const TEXT = new Set(['.js', '.mjs', '.css', '.json', '.map', '.txt', '.svg']);
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;
const known = new Map();
// A WindowProxy survives navigation; its Document does not. Never carry applied versions into a new page.
const documents = new WeakMap();
let work = Promise.resolve();
let generation = -1;
const recent = [];
function record(win, path, action) {
  recent.push({ at: Date.now(), frame: typeof window !== 'undefined' && win === window ? 'page' : (win.name || win.location.pathname), path, action });
  if (recent.length > 50) recent.shift();
}
function enqueue(run) { const next = work.then(run); work = next.catch(() => {}); return next; }
function documentState(doc) {
  if (!documents.has(doc)) documents.set(doc, { sources: new Map(), applied: new Map(), styles: new Map(), observer: null, reloading: false });
  return documents.get(doc);
}

const extOf = (path) => (path.match(/\.[^./]+$/)?.[0] || '').toLowerCase();
const pathOf = (url, base) => { try { const parsed = new URL(url, base); return parsed.origin === location.origin ? decodeURIComponent(parsed.pathname).replace(/^\//, '') : ''; } catch { return ''; } };
const bust = (url, sha) => { const next = new URL(url, location.href); next.searchParams.set('live', `${(sha || 'release').slice(0, 12)}-${Date.now().toString(36)}`); return next.href; };

/** This page's window and the same-origin frames inside it that do not watch the layer themselves. */
export function frames(win = window, found = []) {
  found.push(win);
  for (const frame of win.document.querySelectorAll('iframe,frame')) {
    let child = null;
    try { child = frame.contentWindow; if (!child?.document || child.__fmLiveAssets) continue; } catch { continue; }
    frames(child, found);
  }
  return found;
}

/** Every same-origin URL a frame loaded, by path: elements now in the page plus everything it fetched. */
export function loadedUrls(win) {
  const urls = new Map();
  const add = (url) => { const path = pathOf(url, win.location.href); if (!path) return; if (!urls.has(path)) urls.set(path, new Set()); urls.get(path).add(new URL(url, win.location.href).href); };
  for (const entry of win.performance?.getEntriesByType?.('resource') || []) add(entry.name);
  for (const node of win.document.querySelectorAll('link[href],script[src],img[src]')) add(node.href || node.src);
  return urls;
}

async function sha1(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The bytes' hash as the browser has them: `force-cache` gives the cached copy the page most likely ran. */
async function served(url, path) {
  const response = await fetch(url, { cache: 'force-cache', credentials: 'same-origin' });
  if (!response.ok) return null;
  if (!TEXT.has(extOf(path))) return sha1(await response.arrayBuffer());
  return sha1(new TextEncoder().encode((await response.text()).replace(/\r\n/g, '\n')));
}

function swapLink(link, sha) {
  return new Promise((resolve) => {
    const next = link.cloneNode();
    next.href = bust(link.href, sha);
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); if (ok) link.remove(); else next.remove(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 5000);
    next.addEventListener('load', () => finish(true), { once: true });
    next.addEventListener('error', () => finish(false), { once: true });
    link.after(next);
  });
}

function notice(text) {
  try {
    const doc = window.top.document;
    let pill = doc.getElementById('fm-live-assets-notice');
    if (!pill) {
      pill = doc.createElement('div');
      pill.id = 'fm-live-assets-notice';
      pill.setAttribute('data-fmr-ignore', '');
      pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483600;padding:6px 12px;border-radius:999px;background:#111827;color:#fff;font:600 12px/1.4 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.2);pointer-events:none;transition:opacity .3s';
      doc.body.append(pill);
    }
    pill.textContent = text;
    pill.style.opacity = '1';
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => { pill.style.opacity = '0'; }, 2500);
  } catch { /* a foreign top window */ }
}

const textOf = (url, cache) => fetch(url, { cache, credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : null)).then((t) => t?.replace(/\r\n/g, '\n') ?? null, () => null);

/**
 * Most libraries keep their CSS in the script and inject it as a <style>. When the only difference between the
 * copy the frame ran (the browser's cached copy) and the new one lies inside a stylesheet that appears in the old
 * script after decoding template escapes, exactly once, that <style> gets the new text in place and nothing
 * reloads. Unchanged ${...} values come from the existing style, never by evaluating script code. Changes
 * outside that stylesheet or to its expressions return false so the frame can load the new behavior.
 * The script in memory stays the old one until the next reload; the browser's cache already has the new copy.
 */
async function scriptTexts(path, urls, texts) {
  const url = [...urls][0];
  if (!texts.has(url)) texts.set(url, (async () => {
    const before = await textOf(url, 'force-cache');
    const after = await textOf(url, 'reload');
    await Promise.all([...urls].slice(1).map((other) => textOf(other, 'reload')));
    return { before, after };
  })());
  return texts.get(url);
}

export async function swapInlineStyle(win, path, urls, texts = new Map()) {
  if (!/\.m?js$/i.test(path)) return false;
  const { before, after } = await scriptTexts(path, urls, texts);
  const edit = inlineStyleEdit(before, after);
  return edit ? installStyleEdit(win.document, edit) : false;
}

function inlineStyleEdit(before, after) {
  if (before == null || after == null || before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const oldEnd = before.length - tail;
  const grown = after.length - before.length;
  // The template literal around the edit, before and after.
  const open = templateDelimiter(before, start - 1, -1);
  const close = templateDelimiter(before, oldEnd, 1);
  if (open < 0 || close < 0) return null;
  const oldBody = before.slice(open + 1, close);
  const newBody = after.slice(open + 1, close + grown);
  const oldTemplate = splitTemplate(oldBody), newTemplate = splitTemplate(newBody);
  if (!oldTemplate || !newTemplate || oldTemplate.expressions.join('\0') !== newTemplate.expressions.join('\0')) return null;
  // Portal.util.injectCSS gives these styles stable IDs, including when an app has not rendered yet.
  const prefix = before.slice(0, open);
  let name = prefix.match(/\binjectCSS\(\s*['"]([\w-]+)['"]\s*,\s*$/)?.[1];
  const variable = prefix.match(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*$/)?.[1];
  if (!name && variable) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    name = before.match(new RegExp(`\\binjectCSS\\(\\s*['"]([\\w-]+)['"]\\s*,\\s*${escaped}\\s*\\)`))?.[1];
  }
  return { oldTemplate, newTemplate, id: name ? `css_${name}` : null };
}

function renderTemplate(template, values) {
  return template.literals.map((part, index) => part + (index < values.length ? values[index] : '')).join('');
}

function installStyleEdit(doc, { oldTemplate, newTemplate, id }) {
  // Exactly one <style> in the frame is that template, with the page's own values in its ${...} places.
  const hits = [];
  for (const style of doc.querySelectorAll('style')) {
    const values = templateValues(oldTemplate.literals, style.textContent.replace(/\r\n/g, '\n'));
    if (values) hits.push({ style, values });
  }
  if (hits.length > 1) return false;
  if (!hits.length && (!id || doc.getElementById(id))) return false;
  if (id && doc.head && doc.defaultView?.MutationObserver) {
    const state = documentState(doc);
    const prior = state.styles.get(id);
    state.styles.set(id, { original: prior?.original || oldTemplate, latest: newTemplate });
    if (!state.observer) {
      state.observer = new doc.defaultView.MutationObserver(() => {
        for (const [styleId, entry] of state.styles) {
          const style = doc.getElementById(styleId);
          if (!style || style.tagName !== 'STYLE') continue;
          const values = templateValues(entry.original.literals, style.textContent.replace(/\r\n/g, '\n'));
          if (!values) continue;
          const next = renderTemplate(entry.latest, values);
          if (style.textContent !== next) style.textContent = next;
        }
      });
      state.observer.observe(doc.head, { childList: true, characterData: true, subtree: true });
    }
  } else if (!hits.length) {
    return false; // Cannot retain a deferred style in this document.
  }
  if (hits.length) {
    const { style, values } = hits[0];
    const next = renderTemplate(newTemplate, values);
    guardStyle(style, style.textContent.replace(/\r\n/g, '\n')).next = next;
    style.textContent = next;
  }
  return true;
}

/** Match literal runs directly; large app stylesheets exceed the engine's regexp size limit. */
function templateValues(literals, text) {
  if (literals.length === 1) return text === literals[0] ? [] : null;
  if (!text.startsWith(literals[0])) return null;
  const values = [];
  let at = literals[0].length;
  for (let i = 1; i < literals.length; i++) {
    const literal = literals[i];
    let end;
    if (i === literals.length - 1) {
      if (!text.endsWith(literal)) return null;
      end = text.length - literal.length;
    } else {
      // Adjacent expressions or repeated separators do not identify their values unambiguously.
      if (!literal) return null;
      end = text.indexOf(literal, at);
      if (end < 0 || text.indexOf(literal, end + 1) !== -1) return null;
    }
    if (end < at) return null;
    values.push(text.slice(at, end));
    at = end + literal.length;
  }
  return values;
}

function templateDelimiter(source, start, direction) {
  for (let at = start; at >= 0 && at < source.length; at += direction) {
    if (source[at] !== '`') continue;
    let slashes = 0;
    for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) return at;
  }
  return -1;
}

/** Decode an ordinary template's literal text without executing it or any of its expressions. */
function splitTemplate(body) {
  if (body.length < 20) return null;
  const literals = [], expressions = [];
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  let literal = '';
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === '`') return null; // The edit crossed a template boundary.
    if (char === '$' && body[at + 1] === '{') {
      const close = body.indexOf('}', at + 2);
      const expression = body.slice(at + 2, close);
      // Keep the conservative expression grammar: never interpret nested code or quoted delimiters.
      if (close < 0 || /[{}'"`\\]/.test(expression)) return null;
      literals.push(literal); literal = '';
      expressions.push(expression);
      at = close;
    } else if (char === '\\') {
      const escaped = body[++at];
      if (escaped === undefined || /[1-9]/.test(escaped) || (escaped === '0' && /[0-9]/.test(body[at + 1] || ''))) return null;
      if (escaped === '\n') continue;
      if (escaped === '\r') { if (body[at + 1] === '\n') at++; continue; }
      if (escaped === 'x' || escaped === 'u') {
        const braced = escaped === 'u' && body[at + 1] === '{';
        const from = at + (braced ? 2 : 1);
        const end = braced ? body.indexOf('}', from) : from + (escaped === 'x' ? 2 : 4);
        const hex = body.slice(from, end);
        if (end < from || end > body.length || !/^[0-9a-f]+$/i.test(hex)) return null;
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff) return null;
        literal += String.fromCodePoint(point);
        at = braced ? end : end - 1;
      } else {
        literal += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped;
      }
    } else {
      literal += char;
    }
  }
  literals.push(literal);
  return { literals, expressions };
}

/**
 * The old script is still in memory, and libraries rewrite their <style> on every render (Portal.util.injectCSS).
 * When one writes back the CSS it had before the first swap, put the newest text back before the frame paints.
 */
function guardStyle(style, original) {
  if (style.__fmLiveStyle) return style.__fmLiveStyle;
  const state = { original, next: original };
  style.__fmLiveStyle = state;
  new style.ownerDocument.defaultView.MutationObserver(() => {
    const text = style.textContent.replace(/\r\n/g, '\n');
    if (text === state.original && text !== state.next) style.textContent = state.next;
  }).observe(style, { childList: true, characterData: true, subtree: true });
  return state;
}

/** Applies changes to every frame of this page. Returns what it did, for checking from the console or a test. */
export function apply(changes) { return enqueue(() => applyChanges(changes)); }

async function applyChanges(changes) {
  const done = { swapped: [], reloaded: [] };
  const all = frames();
  const reloads = [];
  const texts = new Map();
  for (const win of all) {
    const doc = win.document;
    const state = documentState(doc);
    let ancestor = win;
    let reloading = false;
    do {
      if (documentState(ancestor.document).reloading) { reloading = true; break; }
      if (!ancestor.parent || ancestor === ancestor.parent) break;
      ancestor = ancestor.parent;
    } while (all.includes(ancestor));
    if (reloading) continue;
    const urls = loadedUrls(win);
    let reload = false;
    for (const { path, sha } of changes) {
      if (!urls.has(path)) continue;
      if (state.applied.has(path) && state.applied.get(path) === sha) { record(win, path, 'already-applied'); continue; }
      const links = [...win.document.querySelectorAll('link[rel~="stylesheet"][href]')].filter((link) => pathOf(link.href, win.location.href) === path);
      const images = IMAGE.test(path) ? [...win.document.querySelectorAll('img[src]')].filter((img) => pathOf(img.src, win.location.href) === path) : [];
      if (extOf(path) === '.css' && links.length) {
        const loaded = await Promise.all(links.map((link) => swapLink(link, sha)));
        if (win.document === doc && loaded.every(Boolean)) { state.applied.set(path, sha); done.swapped.push(path); record(win, path, 'stylesheet-swapped'); }
        continue;
      }
      if (images.length) { images.forEach((img) => { img.src = bust(img.src, sha); }); state.applied.set(path, sha); done.swapped.push(path); continue; }
      if (IMAGE.test(path)) continue;
      if (/\.m?js$/i.test(path)) {
        const fetched = await scriptTexts(path, urls.get(path), texts);
        if (win.document !== doc) break;
        // Retain the pre-fetch copy even if a second save overtakes this fetch or the network fails.
        // Another frame/tab can refresh the HTTP cache; it is not our script's execution state.
        if (!state.sources.has(path) && fetched.before != null) state.sources.set(path, fetched.before);
        // Fetch failures are not evidence of a behavior change. A later notification/hello can retry.
        if (fetched.after == null || !state.sources.has(path)) { record(win, path, 'fetch-unavailable'); continue; }
        // A rapid second save can reach the server before the first notification's fetch finishes.
        // Wait for its notification instead of associating newer bytes with the older version.
        if (/^[a-f0-9]{40}$/i.test(sha || '') && await sha1(new TextEncoder().encode(fetched.after)) !== sha) { record(win, path, 'superseded-fetch'); continue; }
        const retained = state.sources.get(path);
        const before = retained ?? fetched.before;
        const edit = inlineStyleEdit(before, fetched.after);
        if ((retained != null && before === fetched.after) || (edit && installStyleEdit(doc, edit))) {
          state.sources.set(path, fetched.after);
          state.applied.set(path, sha);
          done.swapped.push(path);
          record(win, path, before === fetched.after ? 'unchanged' : 'inline-style-applied');
          continue;
        }
        record(win, path, edit ? 'reload-style-not-matched' : 'reload-script-change');
      } else {
        record(win, path, 'reload-resource-change');
      }
      reload = true;
      // The reload must not take these from the browser's cache: refetch each URL the frame used.
      await Promise.all([...urls.get(path)].map((url) => fetch(url, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
    }
    if (reload && win.document === doc) reloads.push(win);
  }
  // A reload of the page takes its frames with it.
  const targets = reloads.filter((win) => {
    for (let parent = win.parent; parent && parent !== win; parent = parent.parent) {
      if (reloads.includes(parent)) return false;
      if (parent === parent.parent) break;
    }
    return true;
  });
  for (const win of targets) { done.reloaded.push(win === window ? 'page' : win.location.pathname); }
  const names = changes.map((change) => change.path.split('/').pop());
  if (done.swapped.length || targets.length) notice(`Live: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`);
  for (const win of targets) { documentState(win.document).reloading = true; win.location.reload(); }
  return done;
}

/**
 * On connect: a frame that ran a cached copy of a layer file (the release's copy is cached for up to an hour
 * under its ?v= URL) refetches it past the cache and reloads once for that version.
 */
async function verify() {
  const stale = new Map();
  for (const win of frames()) {
    const state = documentState(win.document);
    const urls = loadedUrls(win);
    for (const [path, sha] of known) {
      if (!sha || !urls.has(path) || IMAGE.test(path)) continue;
      if (state.applied.get(path) === sha) continue;
      const retained = state.sources.get(path);
      const hashes = retained == null
        ? await Promise.all([...urls.get(path)].map((url) => served(url, path).catch(() => null)))
        : [await sha1(new TextEncoder().encode(retained))];
      if (hashes.some((hash) => hash && hash === sha)) continue;
      stale.set(path, { path, sha });
    }
  }
  if (stale.size) await applyChanges([...stale.values()]);
}

const EDITABLE_INPUT = /^(?!button$|submit$|reset$|checkbox$|radio$|range$|color$|file$|image$|hidden$)/i;
/** The focused field someone may be typing in, following focus into same-origin frames. */
function editing(doc) {
  let el = doc?.activeElement;
  for (let depth = 0; el && depth < 5; depth += 1) {
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT') return EDITABLE_INPUT.test(el.type || 'text');
    if (el.tagName !== 'IFRAME') return false;
    try { el = el.contentDocument?.activeElement; } catch { return false; }
  }
  return false;
}

/**
 * Reloads `win` onto a new platform release once it is quiet. `note(release)` takes each release the stream
 * reports: the first is the page's own; a different one waits for quiet, and the page's own again (a reconnect
 * that reached a web host still switching) cancels the wait.
 */
export function createReleaseWatch(win, { quietMs = 4000, everyMs = 1000, now = () => Date.now(), reload = () => win.location.reload(), say = notice } = {}) {
  let own = '';
  let waiting = '';
  let lastInput = now();
  let timer = null;
  const listened = new WeakSet();
  const touched = () => { lastInput = now(); };
  const listen = () => {
    for (const frame of frames(win)) {
      if (listened.has(frame)) continue;
      listened.add(frame);
      for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) frame.addEventListener?.(type, touched, { capture: true, passive: true });
    }
  };
  const quiet = () => win.document.visibilityState !== 'hidden' && !editing(win.document) && now() - lastInput >= quietMs;
  const stop = () => { if (timer) win.clearInterval(timer); timer = null; win.document.removeEventListener?.('visibilitychange', check); };
  function check() {
    if (!waiting) return stop();
    listen();
    if (!quiet()) return false;
    stop();
    record(win, waiting, 'reload-release');
    say(`New release · reloading`);
    reload();
    return true;
  }
  function note(release) {
    release = String(release || '');
    if (!release) return false;
    listen();
    if (!own) { own = release; return false; }
    if (release === own) { waiting = ''; stop(); return false; }
    if (waiting === release) return false;
    waiting = release;
    if (!timer) { timer = win.setInterval(check, everyMs); win.document.addEventListener?.('visibilitychange', check); }
    return check();
  }
  return { note, check, state: () => ({ own, waiting }) };
}
let releaseWatch = null;

export function receive(event, data) { return enqueue(() => receiveEvent(event, data)); }

async function receiveEvent(event, data) {
  if (event === 'hello' || event === 'release') (releaseWatch ||= createReleaseWatch(window)).note(data?.release);
  if (event !== 'hello' && event !== 'changed') return;
  const nextGeneration = Number(data?.gen);
  if (Number.isFinite(nextGeneration) && nextGeneration < generation) return;
  if (event === 'hello') {
    // A reconnect can arrive after files were reverted while the page was offline.
    const removed = [...known.keys()].filter((path) => !Object.hasOwn(data?.files || {}, path)).map((path) => ({ path, sha: null }));
    known.clear();
    for (const [path, sha] of Object.entries(data?.files || {})) known.set(path, sha);
    window.FirstMateLiveAssets = { files: () => Object.fromEntries(known), apply, frames, loadedUrls, diagnostics: () => recent.map((entry) => ({ ...entry })) };
    window.dispatchEvent(new CustomEvent('fm:live-assets', { detail: { event } }));
    if (removed.length) await applyChanges(removed);
    await verify();
    if (Number.isFinite(nextGeneration)) generation = nextGeneration;
    return;
  }
  if (event !== 'changed' || !Array.isArray(data?.files)) return;
  for (const { path, sha } of data.files) { if (sha) known.set(path, sha); else known.delete(path); }
  // The dev console's Live layer section redraws on this.
  window.dispatchEvent(new CustomEvent('fm:live-assets', { detail: { event, files: data.files } }));
  await applyChanges(data.files);
  if (Number.isFinite(nextGeneration)) generation = nextGeneration;
}
