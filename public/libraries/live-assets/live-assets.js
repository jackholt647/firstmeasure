/* libraries/live-assets/live-assets.js
 * Applies the live layer to an open page on dev.1m8.ai (docs/architecture/live-layer.md).
 *
 * PlatformRealtime watches `live-assets` on the page's one stream and hands each frame here:
 *   hello   { gen, files: { path: sha } }        the files the layer serves now
 *   changed { gen, files: [{ path, sha|null }] } files written, or gone back to the release (sha null)
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
  const next = link.cloneNode();
  next.href = bust(link.href, sha);
  next.addEventListener('load', () => link.remove(), { once: true });
  next.addEventListener('error', () => next.remove(), { once: true });
  link.after(next);
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
 * script word for word, exactly once, that <style> gets the new text in place and nothing reloads. Any other
 * change (logic, several separate edits, a template with ${...} or escapes) returns false and the frame reloads.
 * The script in memory stays the old one until the next reload; the browser's cache already has the new copy.
 */
export async function swapInlineStyle(win, path, urls, texts = new Map()) {
  if (!/\.m?js$/i.test(path)) return false;
  const url = [...urls][0];
  if (!texts.has(url)) texts.set(url, (async () => {
    const before = await textOf(url, 'force-cache');
    const after = await textOf(url, 'reload');
    await Promise.all([...urls].slice(1).map((other) => textOf(other, 'reload')));
    return { before, after };
  })());
  const { before, after } = await texts.get(url);
  if (before == null || after == null || before === after) return false;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const oldEnd = before.length - tail;
  const grown = after.length - before.length;
  if (before.slice(start, oldEnd).includes('`') || after.slice(start, oldEnd + grown).includes('`')) return false;
  // The template literal around the edit, before and after.
  const open = before.lastIndexOf('`', start - 1);
  const close = before.indexOf('`', oldEnd);
  if (open < 0 || close < 0) return false;
  const oldBody = before.slice(open + 1, close);
  const newBody = after.slice(open + 1, close + grown);
  const oldTemplate = splitTemplate(oldBody), newTemplate = splitTemplate(newBody);
  if (!oldTemplate || !newTemplate || oldTemplate.expressions.join('\0') !== newTemplate.expressions.join('\0')) return false;
  // Exactly one <style> in the frame is that template, with the page's own values in its ${...} places.
  const pattern = new RegExp(`^${oldTemplate.literals.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)')}$`);
  const hits = [];
  for (const style of win.document.querySelectorAll('style')) {
    const match = pattern.exec(style.textContent.replace(/\r\n/g, '\n'));
    if (match) hits.push({ style, values: match.slice(1) });
  }
  if (hits.length !== 1) return false;
  const { style, values } = hits[0];
  const next = newTemplate.literals.map((part, index) => part + (index < values.length ? values[index] : '')).join('');
  guardStyle(style, style.textContent.replace(/\r\n/g, '\n')).next = next;
  style.textContent = next;
  return true;
}

/** A template literal's body as literal text and the ${...} between it, or null when it is not plain enough to rebuild. */
function splitTemplate(body) {
  if (body.includes('\\') || body.length < 20) return null;
  const literals = [], expressions = [];
  let at = 0;
  for (;;) {
    const open = body.indexOf('${', at);
    if (open < 0) { literals.push(body.slice(at)); break; }
    const close = body.indexOf('}', open);
    if (close < 0 || body.slice(open + 2, close).includes('{')) return null;
    literals.push(body.slice(at, open));
    expressions.push(body.slice(open + 2, close));
    at = close + 1;
  }
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
export async function apply(changes) {
  const done = { swapped: [], reloaded: [] };
  const all = frames();
  const reloads = [];
  const texts = new Map();
  for (const win of all) {
    const urls = loadedUrls(win);
    let reload = false;
    for (const { path, sha } of changes) {
      if (!urls.has(path)) continue;
      const links = [...win.document.querySelectorAll('link[rel~="stylesheet"][href]')].filter((link) => pathOf(link.href, win.location.href) === path);
      const images = IMAGE.test(path) ? [...win.document.querySelectorAll('img[src]')].filter((img) => pathOf(img.src, win.location.href) === path) : [];
      if (extOf(path) === '.css' && links.length) { links.forEach((link) => swapLink(link, sha)); done.swapped.push(path); continue; }
      if (images.length) { images.forEach((img) => { img.src = bust(img.src, sha); }); done.swapped.push(path); continue; }
      if (IMAGE.test(path)) continue;
      if (await swapInlineStyle(win, path, urls.get(path), texts)) { done.swapped.push(path); continue; }
      reload = true;
      // The reload must not take these from the browser's cache: refetch each URL the frame used.
      await Promise.all([...urls.get(path)].map((url) => fetch(url, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
    }
    if (reload) reloads.push(win);
  }
  // A reload of the page takes its frames with it.
  const targets = reloads.includes(window) ? [window] : reloads;
  for (const win of targets) { done.reloaded.push(win === window ? 'page' : win.location.pathname); }
  const names = changes.map((change) => change.path.split('/').pop());
  if (done.swapped.length || targets.length) notice(`Live: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`);
  for (const win of targets) win.location.reload();
  return done;
}

/**
 * On connect: a frame that ran a cached copy of a layer file (the release's copy is cached for up to an hour
 * under its ?v= URL) refetches it past the cache and reloads once for that version.
 */
async function verify() {
  const stale = [];
  for (const win of frames()) {
    const urls = loadedUrls(win);
    for (const [path, sha] of known) {
      if (!sha || !urls.has(path) || IMAGE.test(path)) continue;
      const hashes = await Promise.all([...urls.get(path)].map((url) => served(url, path).catch(() => null)));
      if (hashes.some((hash) => hash && hash === sha)) continue;
      const key = `fm-live:${path}:${sha}`;
      try { if (sessionStorage.getItem(key)) continue; sessionStorage.setItem(key, '1'); } catch { continue; }
      stale.push({ path, sha });
    }
  }
  if (stale.length) await apply(stale);
}

export async function receive(event, data) {
  if (event === 'hello') {
    known.clear();
    for (const [path, sha] of Object.entries(data?.files || {})) known.set(path, sha);
    window.FirstMateLiveAssets = { files: () => Object.fromEntries(known), apply, frames, loadedUrls };
    await verify();
    return;
  }
  if (event !== 'changed' || !Array.isArray(data?.files)) return;
  for (const { path, sha } of data.files) { if (sha) known.set(path, sha); else known.delete(path); }
  await apply(data.files);
}
