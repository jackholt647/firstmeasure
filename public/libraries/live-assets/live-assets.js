/* libraries/live-assets/live-assets.js
 * Applies the live layer to an open page on dev.1m8.ai (docs/architecture/live-layer.md).
 *
 * PlatformRealtime watches `live-assets` on the page's one stream and hands each frame here:
 *   hello   { gen, files: { path: sha } }        the files the layer serves now
 *   changed { gen, files: [{ path, sha|null }] } files written, or gone back to the release (sha null)
 *
 * For every frame of this page (the page and its same-origin frames that have no receiver of their own):
 * a changed stylesheet <link> or <img> is swapped in place; anything else the frame loaded (scripts,
 * modules, JSON) reloads that frame only, after the browser's cached copies of those URLs are refetched
 * so the reload cannot run an old copy. Files a frame never loaded are left alone.
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

async function served(url, path) {
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
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

/** Applies changes to every frame of this page. Returns what it did, for checking from the console or a test. */
export async function apply(changes) {
  const done = { swapped: [], reloaded: [] };
  const all = frames();
  const reloads = [];
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
 * On connect: a frame that ran a cached copy of a layer file (the browser kept the release's copy) refetches
 * it and reloads once for that version.
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
