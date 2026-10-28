/* public/libraries/dev-console/dev-console.js
 *
 * The dev console (docs/architecture/dev-console.md): one tray over the right edge of every development page that
 * holds every development control. It folds to a 20 px strip, its width is dragged from its left edge, and it
 * remembers open or folded, the section and the width in this browser. On a desktop the page is docked beside it
 * (dock.js): it behaves as a window narrower by the console's width, folded strip included, and is never covered. Only the development tools audience sees it
 * (GET /v1/signup-sandbox/development/console: development data environment, then a platform administrator or a
 * sandbox organization's settings managers); production answers 404 and nothing is drawn. Everything in it is
 * data-fmr-ignore. Sections are modules in ./sections, loaded when first opened; another library adds one with
 * window.FirstMateDevConsole.register().
 */
import { dock, windowWidth } from './dock.js?v=20261028-dock1';

const VERSION = '20261028-dock1';
const NS = 'dev-console';
const STORE = 'fm-dev-console';
// The page keeps at least APP_MIN px beside the console.
const STRIP = 20, MIN_WIDTH = 300, DEFAULT_WIDTH = 400, PHONE = 640, APP_MIN = 360;

export const T = (key, fallback) => window.PlatformLanguage?.text?.(NS, key, fallback) ?? fallback;
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function csrf() {
  const name = String(window.__APP?.platformSessionCookieName || 'fm_platform_session');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) return '';
  const prefix = encodeURIComponent(name + '_csrf') + '=';
  let jar = ''; try { jar = document.cookie; } catch (_) {}
  const cookie = jar.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  try { return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : ''; } catch (_) { return ''; }
}
/** JSON request to this origin with the platform session; throws an Error carrying status, code and the body. */
export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') { const token = csrf(); if (token) headers['X-Platform-CSRF'] = token; }
  const response = await fetch(location.origin + path, { method, headers, credentials: 'include', cache: 'no-store', body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok || data?.ok === false) {
    // Platform errors carry { error: code, message }; the signup sandbox's carry { code, error: message }.
    const error = new Error(String(data?.message || data?.error || `Request failed (${response.status})`));
    Object.assign(error, { status: response.status, code: String(data?.code || (data?.message ? data?.error : '') || ''), body: data });
    throw error;
  }
  return data || {};
}

function readStore() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { return {}; } }
function writeStore(patch) { try { localStorage.setItem(STORE, JSON.stringify({ ...readStore(), ...patch })); } catch (_) {} }

/*
 * Sections in rail order. `when` reads the console endpoint's `sections`; a section without `when` is always shown
 * (its module says when what it needs is not on dev yet).
 */
const SECTIONS = [
  { id: 'test-run', icon: 'fa-flask', label: ['dc_section_test_run', 'Test run'], when: (s) => s.test_run, load: () => import(`./sections/test-run.js?v=${VERSION}`) },
  { id: 'org-state', icon: 'fa-toggle-on', label: ['dc_section_org_state', 'Flags and settings'], load: () => import(`./sections/org-state.js?v=${VERSION}`) },
  { id: 'guided', icon: 'fa-route', label: ['dc_section_guided', 'Guided experiences'], when: (s) => s.guided && !!window.FirstMateGuides?.devPanel, load: () => import(`./sections/guided.js?v=${VERSION}`) },
  { id: 'config', icon: 'fa-book', label: ['dc_section_config', 'Config library'], load: () => import(`./sections/config-library.js?v=${VERSION}`) },
  { id: 'synthetic', icon: 'fa-wand-magic-sparkles', label: ['dc_section_synthetic', 'Synthetic data'], when: (s) => s.synthetic_data, load: () => import(`./sections/synthetic-data.js?v=${VERSION}`) },
  { id: 'users', icon: 'fa-users', label: ['dc_section_users', 'Test users'], when: () => !!window.PlatformAPI?.users?.list, load: () => import(`./sections/test-users.js?v=${VERSION}`) },
  { id: 'layers', icon: 'fa-layer-group', label: ['dc_section_layers', 'Software layers'], when: (s) => s.software_layers, load: () => import(`./sections/software-layers.js?v=${VERSION}`) },
  { id: 'live', icon: 'fa-bolt', label: ['dc_section_live', 'Live layer'], when: (s) => s.live, load: () => import(`./sections/live-layer.js?v=${VERSION}`) },
  { id: 'push', icon: 'fa-code-merge', label: ['dc_section_push', 'Dev push queue'], load: () => import(`./sections/push-queue.js?v=${VERSION}`) }
];

/*
 * Who sees the console. The console endpoint answers it in one call. Until that endpoint is on a development host
 * (it ships on the platform lane), the same audience is read from what the older tools already answer: the sandbox
 * development tools, the sandbox run and the guided experiences editor flag.
 */
async function readAccess() {
  try { return await api('/v1/signup-sandbox/development/console'); }
  catch (error) { if (error.status !== 404 || !/^Route /.test(String(error.body?.message || ''))) return null; }
  const ok = (promise) => promise.then(() => true, () => false);
  const [sandbox, run] = await Promise.all([ok(api('/v1/signup-sandbox/development')), api('/v1/signup-sandbox/current-instance').then((r) => !!r.instance, () => false)]);
  let guided = false;
  for (let i = 0; i < 30 && !guided && window.FirstMateGuides; i++) { guided = !!window.FirstMateGuides.isDevEditor?.(); if (!guided) await new Promise((r) => setTimeout(r, 200)); }
  if (!sandbox && !run && !guided) return null;
  return { ok: true, sections: { test_run: run, synthetic_data: sandbox, software_layers: sandbox, guided: guided || sandbox, live: !!window.FirstMateLiveAssets || location.hostname === 'dev.1m8.ai' } };
}

let mounted = false;
const extra = [];
const state = { access: null, open: false, expanded: false, section: '', width: DEFAULT_WIDTH, loaded: new Map() };
let tray, strip, rail, body, title;

export async function mount() {
  if (mounted || window.top !== window) return;
  mounted = true;
  const access = await readAccess().catch(() => null);
  if (!access) { mounted = false; return; }
  state.access = access;
  const saved = readStore();
  state.open = saved.open === true;
  state.width = Math.max(MIN_WIDTH, Number(saved.width) || DEFAULT_WIDTH);
  state.expanded = saved.expanded === true;
  state.section = String(saved.section || '');
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.setAttribute('data-fm-dc', ''); css.href = `/libraries/dev-console/dev-console.css?v=${VERSION}`; document.head.append(css);
  // Docking needs the console's stylesheet; a page that cannot load it still gets the console.
  await new Promise((resolve) => { css.onload = css.onerror = resolve; setTimeout(resolve, 4000); });
  build();
  window.FirstMateDevConsole = { register, open: (id) => setOpen(true, id), fold: () => setOpen(false), sections: () => visible().map((s) => s.id), access: () => state.access };
  window.dispatchEvent(new CustomEvent('fm:dev-console:ready'));
}

/** Adds a section from another library: { id, icon, label: [key, English], order?, render(root, ctx) }. */
function register(section) {
  if (!section?.id || extra.some((s) => s.id === section.id)) return;
  extra.push({ ...section, load: async () => ({ mount: section.render }) });
  if (tray) renderRail();
}
function visible() {
  const sections = state.access?.sections || {};
  return [...SECTIONS.filter((s) => !s.when || s.when(sections)), ...extra];
}

function build() {
  strip = document.createElement('button');
  strip.type = 'button'; strip.className = 'fm-dc-strip'; strip.setAttribute('data-fmr-ignore', '');
  strip.setAttribute('aria-label', T('dc_open', 'Open the dev console'));
  strip.title = T('dc_open', 'Open the dev console');
  strip.innerHTML = '<i class="fas fa-chevron-left" aria-hidden="true"></i><span>DEV</span>';
  strip.onclick = () => setOpen(true);

  tray = document.createElement('aside');
  tray.className = 'fm-dc'; tray.setAttribute('data-fmr-ignore', '');
  tray.setAttribute('aria-label', T('dc_title', 'Dev console'));
  tray.innerHTML = `<div class="fm-dc-resize" role="separator" aria-orientation="vertical" aria-label="${esc(T('dc_resize', 'Resize the dev console'))}" tabindex="0"></div>
    <nav class="fm-dc-rail" aria-label="${esc(T('dc_sections', 'Dev console sections'))}"></nav>
    <section class="fm-dc-main"><header class="fm-dc-head"><h2></h2><button type="button" class="fm-dc-headbtn fm-dc-expand" aria-pressed="false" aria-label="${esc(T('dc_expand', 'Expand the dev console'))}" title="${esc(T('dc_expand', 'Expand the dev console'))}"><i class="fas fa-up-right-and-down-left-from-center" aria-hidden="true"></i></button><button type="button" class="fm-dc-headbtn fm-dc-fold" aria-label="${esc(T('dc_fold', 'Fold the dev console'))}" title="${esc(T('dc_fold', 'Fold the dev console'))}"><i class="fas fa-chevron-right" aria-hidden="true"></i></button></header><div class="fm-dc-body"></div></section>`;
  rail = tray.querySelector('.fm-dc-rail'); body = tray.querySelector('.fm-dc-body'); title = tray.querySelector('.fm-dc-head h2');
  tray.querySelector('.fm-dc-fold').onclick = () => setOpen(false);
  tray.querySelector('.fm-dc-expand').onclick = () => { state.expanded = !state.expanded; writeStore({ expanded: state.expanded }); layout(); };
  // On <html>, outside <body>: the docked page's fixed layers are contained by <body> and never reach the console.
  document.documentElement.append(strip, tray);
  // Outside <body>, so it takes the page's font from there.
  tray.style.fontFamily = getComputedStyle(document.body).fontFamily;
  resizer(tray.querySelector('.fm-dc-resize'));
  phoneEntry();
  renderRail();
  window.addEventListener('resize', layout);
  setOpen(state.open, state.section, { initial: true });
}

function renderRail() {
  const list = visible();
  if (!list.some((s) => s.id === state.section)) state.section = list[0]?.id || '';
  rail.replaceChildren(...list.map((section) => {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.dcSection = section.id;
    const label = T(...section.label);
    button.setAttribute('aria-label', label); button.title = label;
    button.setAttribute('aria-current', String(section.id === state.section));
    button.innerHTML = `<i class="fas ${esc(section.icon)}" aria-hidden="true"></i>`;
    button.onclick = () => select(section.id);
    return button;
  }));
}

function setOpen(open, section, { initial = false } = {}) {
  state.open = !!open;
  tray.hidden = !state.open; strip.hidden = state.open;
  document.documentElement.classList.toggle('fm-dc-open', state.open);
  if (!initial) writeStore({ open: state.open });
  layout();
  if (state.open) select(section || state.section);
}

async function select(id) {
  const section = visible().find((s) => s.id === id) || visible()[0];
  if (!section) return;
  state.section = section.id; writeStore({ section: section.id });
  rail.querySelectorAll('[data-dc-section]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.dcSection === section.id)));
  title.textContent = T(...section.label);
  for (const pane of body.children) pane.hidden = pane.dataset.dcPane !== section.id;
  let entry = state.loaded.get(section.id);
  if (!entry) {
    const pane = document.createElement('div'); pane.className = 'fm-dc-pane'; pane.dataset.dcPane = section.id;
    body.append(pane);
    entry = { pane, handle: null }; state.loaded.set(section.id, entry);
    try {
      const module = await section.load();
      entry.handle = await module.mount(pane, context()) || null;
    } catch (error) {
      pane.innerHTML = `<p class="fm-dc-error">${esc(error?.message || T('dc_section_failed', 'This section could not load.'))}</p>`;
      state.loaded.delete(section.id);
    }
  } else entry.handle?.shown?.();
}

function context() {
  return { api, T, esc, access: state.access, orgId: () => String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ''), open: (id) => setOpen(true, id), toast };
}

/** A short line at the bottom of the tray (or the page when folded). */
export function toast(message) {
  const note = document.createElement('div');
  note.className = 'fm-dc-toast'; note.setAttribute('data-fmr-ignore', ''); note.setAttribute('role', 'status');
  note.textContent = message;
  (state.open ? tray : document.body).append(note);
  setTimeout(() => note.remove(), 2600);
}

// The window's real width: the docked page is told the remaining width.
function phone() { return windowWidth() <= PHONE; }
function layout() {
  if (!tray) return;
  const real = windowWidth(), max = Math.max(MIN_WIDTH, real - APP_MIN);
  const width = phone() ? real : Math.min(state.expanded ? Math.max(state.width, Math.round(real * 0.6)) : state.width, max);
  tray.style.width = width + 'px';
  const expand = tray.querySelector('.fm-dc-expand');
  expand.setAttribute('aria-pressed', String(state.expanded));
  expand.querySelector('i').className = `fas ${state.expanded ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'}`;
  expand.title = state.expanded ? T('dc_restore', 'Restore the dev console width') : T('dc_expand', 'Expand the dev console');
  expand.setAttribute('aria-label', expand.title);
  // A phone keeps the console over the page; a desktop page is docked beside it, folded strip included.
  dock(phone() ? 0 : state.open ? width : STRIP);
}

function resizer(handle) {
  let startX = 0, startWidth = 0;
  // The handle captures the pointer, so a drag across the project window's frame keeps reaching it.
  const move = (event) => { state.expanded = false; state.width = Math.max(MIN_WIDTH, startWidth + (startX - event.clientX)); layout(); };
  const up = (event) => {
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
    try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
    tray.classList.remove('fm-dc-resizing'); writeStore({ width: state.width, expanded: state.expanded });
  };
  handle.addEventListener('pointerdown', (event) => {
    if (phone()) return;
    event.preventDefault(); startX = event.clientX; startWidth = tray.getBoundingClientRect().width;
    tray.classList.add('fm-dc-resizing');
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); state.width = Math.max(MIN_WIDTH, state.width + (event.key === 'ArrowLeft' ? 24 : -24)); layout(); writeStore({ width: state.width });
  });
}

/** On a phone the portal's ⋯ sheet gets a Dev console entry too: the strip is narrow under a thumb. */
function phoneEntry() {
  const menu = document.getElementById('mobilePlatformMoreMenu');
  if (!menu || document.getElementById('mobilePlatformMoreDevConsole')) return;
  const item = document.createElement('button');
  item.type = 'button'; item.id = 'mobilePlatformMoreDevConsole'; item.className = 'ptb-more-item'; item.setAttribute('data-fmr-ignore', '');
  item.innerHTML = `<i class="fas fa-code" aria-hidden="true"></i><span>${esc(T('dc_title', 'Dev console'))}</span>`;
  item.onclick = () => { menu.classList.remove('visible'); setOpen(true); };
  menu.prepend(item);
}
