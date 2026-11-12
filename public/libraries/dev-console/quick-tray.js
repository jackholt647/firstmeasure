/* public/libraries/dev-console/quick-tray.js
 *
 * The dev tray (docs/architecture/dev-console.md, "Quick tray"): on a phone, a shake opens a tray over the bottom half
 * of the page whose job is filing Tracker issues fast. A small header (target workspace, the full dev menu), a box for
 * the next issue with Go (straight to Ready in General platform work unless switched; Go closes the tray), a
 * screenshot of the page as it looks without the tray, and the workspace's issues. Mounted by dev-console.js for the
 * dev console's audience only, so production never loads it. Everything it draws is data-fmr-ignore.
 */
const NS = 'dev-console';
const T = (key, fallback) => window.PlatformLanguage?.text?.(NS, key, fallback) ?? fallback;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
import { trackerClient, composeIssue, groupIssues, DEFAULT_WORKSPACE, TRACKER } from './tracker-client.js?v=20261112-tray2';
import { watchShake, requestMotionPermission } from './shake.js?v=20261112-tray2';

const VERSION = '20261112-tray2';
const DRAFT = 'fm-dev-tray-draft';
const REFRESH_MS = 20000;
const tracker = trackerClient();
const state = { open: false, workspaces: [], workspace: null, view: 'open', issues: [], expanded: '', shot: null, busy: false, error: '', loading: false, loadedAt: 0 };
let root, backdrop, timer = 0, ctx = {};

const draft = { get() { try { return localStorage.getItem(DRAFT) || ''; } catch (_) { return ''; } }, set(v) { try { v ? localStorage.setItem(DRAFT, v) : localStorage.removeItem(DRAFT); } catch (_) {} } };

/** ctx: { openConsole() } — opens the full dev menu. */
export function mountQuickTray(options = {}) {
  if (root) return api;
  ctx = options;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.setAttribute('data-fm-qt', ''); css.href = `/libraries/dev-console/quick-tray.css?v=${VERSION}`; document.head.append(css);
  backdrop = document.createElement('div');
  backdrop.className = 'fm-qt-backdrop'; backdrop.hidden = true; backdrop.setAttribute('data-fmr-ignore', '');
  backdrop.onclick = () => close();
  root = document.createElement('section');
  root.className = 'fm-qt'; root.hidden = true;
  root.setAttribute('data-fmr-ignore', ''); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', T('dc_tray_title', 'Dev tray'));
  root.innerHTML = `<div class="fm-qt-grab" aria-hidden="true"></div>
    <header class="fm-qt-head">
      <span class="fm-qt-name"><i class="fas fa-bug" aria-hidden="true"></i>${esc(T('dc_tray_title', 'Dev tray'))}</span>
      <span class="fm-qt-who"></span>
      <button type="button" class="fm-qt-icon fm-qt-close" aria-label="${esc(T('dc_tray_close', 'Close the dev tray'))}" title="${esc(T('dc_tray_close', 'Close the dev tray'))}"><i class="fas fa-chevron-down" aria-hidden="true"></i></button>
      <button type="button" class="fm-qt-icon fm-qt-menu" aria-label="${esc(T('dc_tray_full_menu', 'Open the full dev menu'))}" title="${esc(T('dc_tray_full_menu', 'Open the full dev menu'))}"><i class="fas fa-sliders" aria-hidden="true"></i></button>
    </header>
    <form class="fm-qt-compose" novalidate>
      <div class="fm-qt-box">
        <textarea class="fm-qt-text" rows="3" enterkeyhint="send" aria-label="${esc(T('dc_tray_issue_label', 'Next issue'))}" placeholder="${esc(T('dc_tray_issue_placeholder', 'What should change?'))}"></textarea>
        <button type="submit" class="fm-qt-go">${esc(T('dc_tray_go', 'Go'))}</button>
      </div>
      <div class="fm-qt-opts">
        <button type="button" class="fm-qt-chip fm-qt-shot" aria-pressed="false"><i class="fas fa-camera" aria-hidden="true"></i><span>${esc(T('dc_tray_screenshot', 'Screenshot'))}</span></button>
        <span class="fm-qt-thumb" hidden><img alt="${esc(T('dc_tray_screenshot_alt', 'Screenshot to attach'))}"><button type="button" class="fm-qt-unshot" aria-label="${esc(T('dc_tray_screenshot_remove', 'Remove the screenshot'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button></span>
        <label class="fm-qt-chip fm-qt-target"><i class="fas fa-arrow-right" aria-hidden="true"></i><select aria-label="${esc(T('dc_tray_workspace', 'Workspace'))}"></select></label>
      </div>
      <p class="fm-qt-error" role="alert" hidden></p>
    </form>
    <div class="fm-qt-list" aria-live="polite"></div>`;
  document.documentElement.append(backdrop, root);
  root.style.fontFamily = getComputedStyle(document.body).fontFamily;
  const $ = (s) => root.querySelector(s);
  const text = $('.fm-qt-text');
  text.value = draft.get();
  text.addEventListener('input', () => draft.set(text.value));
  text.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } });
  $('.fm-qt-compose').addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  $('.fm-qt-close').onclick = () => close();
  $('.fm-qt-menu').onclick = () => { close(); ctx.openConsole?.(); };
  $('.fm-qt-shot').onclick = () => takeShot();
  $('.fm-qt-unshot').onclick = () => setShot(null);
  $('.fm-qt-target select').onchange = (event) => { state.workspace = state.workspaces.find((w) => w.id === event.target.value) || state.workspace; state.issues = []; render(); refresh(); };
  swipeToClose($('.fm-qt-grab'), $('.fm-qt-head'));
  document.addEventListener('keydown', (event) => { if (state.open && event.key === 'Escape') close(); });
  watchShake(() => (state.open ? null : open()));
  // An on-screen keyboard that overlays the page (iOS) would hide the tray: lift it above the keyboard.
  const vv = window.visualViewport;
  if (vv) { const lift = () => root.style.setProperty('--qt-kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`); vv.addEventListener('resize', lift); vv.addEventListener('scroll', lift); }
  return api;
}

const api = { open: () => open(), close: () => close(), isOpen: () => state.open, tracker };

async function open() {
  if (!root || state.open) return;
  // iOS Safari reports motion only after a tap asks; opening from a tap is the chance to ask.
  requestMotionPermission().catch(() => {});
  state.open = true; state.error = '';
  root.hidden = false; backdrop.hidden = false;
  requestAnimationFrame(() => root.classList.add('fm-qt-in'));
  render();
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  await refresh();
}
function close() {
  if (!state.open) return;
  state.open = false; clearInterval(timer);
  root.classList.remove('fm-qt-in');
  root.querySelector('.fm-qt-text')?.blur();
  backdrop.hidden = true;
  setTimeout(() => { if (!state.open) root.hidden = true; }, 200);
}

async function refresh() {
  if (!tracker.signedIn) { render(); return; }
  state.loading = true; render();
  try {
    if (!state.workspaces.length) {
      state.workspaces = await tracker.workspaces();
      state.workspace = state.workspaces.find((w) => w.name === DEFAULT_WORKSPACE) || state.workspaces[0] || null;
    }
    if (state.workspace) state.issues = await tracker.issues(state.workspace.id, state.view);
    state.error = ''; state.loadedAt = Date.now();
  } catch (error) { state.error = error.message; }
  state.loading = false; render();
}

async function submit() {
  const text = root.querySelector('.fm-qt-text');
  const body = text.value.trim();
  if (state.busy) return;
  if (!body) { text.focus(); return; }
  if (!tracker.signedIn) { state.error = T('dc_tray_sign_in_first', 'Sign in to Tracker below first.'); render(); return; }
  if (!state.workspace) { state.error = T('dc_tray_no_workspace', 'No Tracker workspace to file into.'); render(); return; }
  state.busy = true; state.error = ''; render();
  try {
    let screenshotUrl = '';
    if (state.shot) screenshotUrl = (await tracker.upload(state.shot.blob))?.url || '';
    const info = window.PhoneFeatures?.info?.();
    const issue = await tracker.create(composeIssue(body, {
      workspaceId: state.workspace.id, screenshotUrl,
      page: location.pathname + location.search + location.hash,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      app: info ? `FirstMate ${info.platform} ${info.version}` : navigator.userAgent.slice(0, 160)
    }));
    text.value = ''; draft.set(''); setShot(null, { quiet: true });
    state.busy = false;
    close();
    ctx.toast?.(T('dc_tray_filed', 'Filed {key}').replace('{key}', issue?.key || ''));
    window.PhoneFeatures?.haptic?.().catch?.(() => {});
    state.issues = [issue, ...state.issues.filter((i) => i.id !== issue?.id)];
  } catch (error) {
    state.busy = false; state.error = error.message; render();
  }
}

// ---------------------------------------------------------------- screenshot

/** The page as it looks with the tray closed: the app captures its web view; a browser renders the page. */
async function takeShot() {
  const button = root.querySelector('.fm-qt-shot');
  button.disabled = true;
  try { setShot(await capture()); }
  catch (error) { state.error = error.message || T('dc_tray_screenshot_failed', 'The screenshot could not be taken.'); render(); }
  finally { button.disabled = false; }
}
async function capture() {
  const phone = window.PhoneFeatures;
  if (phone?.supports?.('screenshot')) {
    document.documentElement.classList.add('fm-qt-capturing');
    try {
      await frames(2); await new Promise((r) => setTimeout(r, 60));
      return await phone.screenshot();
    } finally { document.documentElement.classList.remove('fm-qt-capturing'); }
  }
  // A browser: draw the page (not the tray, which is outside <body>) into a canvas. Frames from other origins and
  // some effects do not draw; the app's capture has neither limit.
  if (!window.html2canvas) await script('/libraries/chat-embed/html2canvas.min.js');
  const canvas = await window.html2canvas(document.body, {
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff', logging: false, useCORS: true,
    x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight, windowWidth: window.innerWidth, windowHeight: window.innerHeight,
    scale: Math.min(2, window.devicePixelRatio || 1), ignoreElements: (el) => el.hasAttribute?.('data-fmr-ignore') && el.classList?.contains('fm-qt')
  });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(T('dc_tray_screenshot_failed', 'The screenshot could not be taken.')))), 'image/jpeg', 0.85));
}
const frames = (n) => new Promise((resolve) => { const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step); });
function script(src) {
  return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(T('dc_tray_screenshot_failed', 'The screenshot could not be taken.'))); document.head.append(s); });
}
function setShot(blob, { quiet = false } = {}) {
  if (state.shot?.url) URL.revokeObjectURL(state.shot.url);
  state.shot = blob ? { blob, url: URL.createObjectURL(blob) } : null;
  if (!quiet) render();
}

// ---------------------------------------------------------------- drawing

function render() {
  if (!root) return;
  const $ = (s) => root.querySelector(s);
  const who = $('.fm-qt-who');
  who.textContent = tracker.signedIn ? (tracker.user?.name || '') : '';
  const select = $('.fm-qt-target select');
  const options = state.workspaces.length ? state.workspaces : [{ id: '', name: DEFAULT_WORKSPACE }];
  select.innerHTML = options.map((w) => `<option value="${esc(w.id)}"${w.id === state.workspace?.id ? ' selected' : ''}>${esc(w.name)}</option>`).join('');
  select.disabled = !state.workspaces.length;
  const go = $('.fm-qt-go');
  go.disabled = state.busy; go.textContent = state.busy ? T('dc_tray_filing', 'Filing…') : T('dc_tray_go', 'Go');
  $('.fm-qt-shot').setAttribute('aria-pressed', String(!!state.shot));
  $('.fm-qt-shot').hidden = !!state.shot;
  const thumb = $('.fm-qt-thumb');
  thumb.hidden = !state.shot;
  if (state.shot) thumb.querySelector('img').src = state.shot.url;
  const error = $('.fm-qt-error');
  error.hidden = !state.error; error.textContent = state.error;
  renderList($('.fm-qt-list'));
}

function renderList(list) {
  // Signed out: the sign-in form, kept across redraws so a wrong password does not clear what was typed.
  if (!tracker.signedIn) { if (!list.querySelector('.fm-qt-signin')) { list.innerHTML = signInForm(); wireSignIn(list); } return; }
  const tabs = `<div class="fm-qt-tabs" role="tablist">
      ${['open', 'done'].map((v) => `<button type="button" role="tab" data-qt-view="${v}" aria-selected="${state.view === v}">${esc(v === 'open' ? T('dc_tray_view_open', 'Open') : T('dc_tray_view_done', 'Done this week'))}</button>`).join('')}
      <span class="fm-qt-spacer"></span>
      <a class="fm-qt-tracker" href="${esc(state.workspace ? `${TRACKER}/project/${state.workspace.id}` : TRACKER)}" target="_blank" rel="noopener">${esc(T('dc_tray_open_tracker', 'Tracker'))}<i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>
      <button type="button" class="fm-qt-icon fm-qt-refresh${state.loading ? ' fm-qt-spin' : ''}" aria-label="${esc(T('dc_tray_refresh', 'Refresh'))}" title="${esc(T('dc_tray_refresh', 'Refresh'))}"><i class="fas fa-rotate" aria-hidden="true"></i></button>
    </div>`;
  const groups = groupIssues(state.issues);
  const body = groups.length ? groups.map((g) => `<section class="fm-qt-group"><h3><span class="fm-qt-dot" style="--c:${esc(g.color || '#98a2b3')}"></span>${esc(g.name)}<small>${g.issues.length}</small></h3>
      <ul>${g.issues.map(row).join('')}</ul></section>`).join('')
    : `<p class="fm-qt-empty">${esc(state.loading ? T('dc_tray_loading', 'Loading issues…') : state.view === 'open' ? T('dc_tray_none_open', 'No open issues here.') : T('dc_tray_none_done', 'Nothing finished this week.'))}</p>`;
  const signedOut = `<p class="fm-qt-foot">${esc(T('dc_tray_signed_in_as', 'Tracker: {name}').replace('{name}', tracker.user?.email || tracker.user?.name || ''))} · <button type="button" class="fm-qt-link fm-qt-signout">${esc(T('dc_tray_sign_out', 'Sign out'))}</button></p>`;
  list.innerHTML = tabs + body + signedOut;
  list.querySelectorAll('[data-qt-view]').forEach((b) => { b.onclick = () => { state.view = b.dataset.qtView; state.issues = []; render(); refresh(); }; });
  list.querySelector('.fm-qt-refresh').onclick = () => refresh();
  list.querySelector('.fm-qt-signout').onclick = async () => { await tracker.signOut(); Object.assign(state, { workspaces: [], workspace: null, issues: [] }); render(); };
  list.querySelectorAll('[data-qt-issue]').forEach((b) => { b.onclick = () => toggle(b.dataset.qtIssue, b.closest('li')); });
}

function row(issue) {
  const agent = issue.agent?.live ? `<span class="fm-qt-agent" title="${esc(T('dc_tray_agent_working', 'An agent is working on it'))}"><i class="fas fa-robot" aria-hidden="true"></i></span>` : '';
  const needs = issue.needs_input ? `<span class="fm-qt-badge">${esc(T('dc_tray_needs_input', 'Needs input'))}</span>` : '';
  return `<li${state.expanded === issue.key ? ' class="fm-qt-open"' : ''}><button type="button" class="fm-qt-row" data-qt-issue="${esc(issue.key)}" aria-expanded="${state.expanded === issue.key}">
      <span class="fm-qt-key">${esc(issue.key)}</span>
      <span class="fm-qt-ttl">${issue.title ? esc(issue.title) : `<em>${esc(T('dc_tray_titling', 'Titling…'))}</em>`}</span>
      ${needs}${agent}<time datetime="${esc(issue.updated_at || '')}">${esc(ago(issue.updated_at))}</time>
    </button>${state.expanded === issue.key ? '<div class="fm-qt-detail"></div>' : ''}</li>`;
}

async function toggle(key, li) {
  state.expanded = state.expanded === key ? '' : key;
  render();
  if (!state.expanded) return;
  const detail = root.querySelector(`[data-qt-issue="${CSS.escape(key)}"]`)?.parentElement?.querySelector('.fm-qt-detail');
  if (!detail) return;
  detail.innerHTML = `<p class="fm-qt-empty">${esc(T('dc_tray_loading_issue', 'Loading…'))}</p>`;
  try {
    const [issue, comments] = await Promise.all([tracker.issue(key), tracker.comments(key).catch(() => [])]);
    if (state.expanded !== key) return;
    const latest = (comments || []).slice(-3);
    detail.innerHTML = `${markdown(issue.description) || `<p class="fm-qt-empty">${esc(T('dc_tray_no_description', 'No description.'))}</p>`}
      ${latest.length ? `<h4>${esc(T('dc_tray_latest', 'Latest'))}</h4>${latest.map((c) => `<div class="fm-qt-comment"><b>${esc(c.author?.name || c.user?.name || '')}</b> <time>${esc(ago(c.created_at))}</time>${markdown(c.body, 600)}</div>`).join('')}` : ''}
      <a class="fm-qt-link" href="${esc(`${TRACKER}/issue/${issue.key}`)}" target="_blank" rel="noopener">${esc(T('dc_tray_open_in_tracker', 'Open {key} in Tracker').replace('{key}', issue.key))}</a>`;
  } catch (error) { detail.innerHTML = `<p class="fm-qt-error">${esc(error.message)}</p>`; }
}

/** Enough Markdown for a glance: paragraphs, Tracker's uploaded images as thumbnails, links as text. */
function markdown(source, max = 1500) {
  let text = String(source || '').trim();
  if (!text) return '';
  if (text.length > max) text = text.slice(0, max) + '…';
  return text.split(/\n{2,}/).map((block) => {
    const image = /^!\[[^\]]*\]\((https:\/\/tracker\.1m8\.ai\/uploads\/[\w.-]+)\)$/.exec(block.trim());
    if (image) return `<a href="${esc(image[1])}" target="_blank" rel="noopener"><img class="fm-qt-img" src="${esc(image[1])}" alt="" loading="lazy"></a>`;
    return `<p>${esc(block.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]{1,2}([^*_`]+)[*_`]{1,2}/g, '$1'))}</p>`;
  }).join('');
}

function ago(iso) {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return T('dc_tray_now', 'now');
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function signInForm() {
  return `<form class="fm-qt-signin" autocomplete="off">
      <p>${esc(T('dc_tray_sign_in_intro', 'Sign in to Tracker once on this device to file and see issues.'))}</p>
      <input type="email" name="tracker-email" autocomplete="off" inputmode="email" required aria-label="${esc(T('dc_tray_email', 'Tracker email'))}" placeholder="${esc(T('dc_tray_email', 'Tracker email'))}">
      <input type="password" name="tracker-password" autocomplete="new-password" required aria-label="${esc(T('dc_tray_password', 'Tracker password'))}" placeholder="${esc(T('dc_tray_password', 'Tracker password'))}">
      <button type="submit" class="fm-qt-go">${esc(T('dc_tray_sign_in', 'Sign in'))}</button>
    </form>`;
}
function wireSignIn(list) {
  const form = list.querySelector('.fm-qt-signin');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('button'); button.disabled = true;
    try { await tracker.signIn(form['tracker-email'].value.trim(), form['tracker-password'].value); state.error = ''; await refresh(); }
    catch (error) { state.error = error.message; button.disabled = false; form['tracker-password'].value = ''; form['tracker-password'].focus(); render(); }
  };
}

/** Drag the grab bar or header down to close. */
function swipeToClose(...handles) {
  let startY = null, dy = 0;
  const move = (event) => { if (startY == null) return; dy = Math.max(0, event.clientY - startY); root.style.transform = dy ? `translateY(${dy}px)` : ''; };
  const end = () => { if (startY == null) return; startY = null; root.style.transform = ''; if (dy > 80) close(); dy = 0; };
  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => { if (event.target.closest('button,select,a')) return; startY = event.clientY; dy = 0; try { handle.setPointerCapture(event.pointerId); } catch (_) {} });
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }
}
